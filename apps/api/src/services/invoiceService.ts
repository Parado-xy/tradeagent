// apps/api/src/services/invoiceService.ts
//
// Invoice lifecycle:
//   DRAFT  → created from voice dictation or manually
//   SENT   → Stripe link generated + texted to customer
//   PAID   → Stripe webhook confirmed payment
//   VOID   → cancelled before payment

import Stripe from "stripe";
import twilio from "twilio";
import {
  PrismaClient,
  InvoiceStatus,
  JobStatus,
} from "../../../../db/generated/client";
import {
  InvoiceLineItem,
  transcribeAndBuildLineItems,
} from "./transcriptionService";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

// ── createInvoiceFromVoice ────────────────────────────────────
// Primary path. Tech records a voice note from the van.
// We transcribe it, match to the price book, build line items.
export async function createInvoiceFromVoice(
  db: PrismaClient,
  jobId: string,
  audioUrl: string,
) {
  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { contact: true, invoice: true },
  });

  if (!job) {
    throw Object.assign(new Error("Job not found"), { statusCode: 404 });
  }

  if (job.invoice) {
    throw Object.assign(new Error("Invoice already exists for this job"), {
      statusCode: 409,
    });
  }

  const { transcript, lineItems, needsReview } =
    await transcribeAndBuildLineItems(db, job.tenantId, audioUrl);

  const { subtotal, total } = calculateTotals(lineItems);

  const invoice = await db.invoice.create({
    data: {
      tenantId: job.tenantId,
      jobId,
      status: InvoiceStatus.DRAFT,
      audioTranscriptUrl: audioUrl,
      lineItems: lineItems as any,
      subtotal,
      taxRate: 0,
      total,
    },
    include: { job: { include: { contact: true } } },
  });

  return { invoice, transcript, needsReview };
}

// ── createInvoiceManually ─────────────────────────────────────
// Operator builds the invoice from the dashboard.
export async function createInvoiceManually(
  db: PrismaClient,
  jobId: string,
  lineItems: InvoiceLineItem[],
) {
  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { invoice: true },
  });

  if (!job) {
    throw Object.assign(new Error("Job not found"), { statusCode: 404 });
  }

  if (job.invoice) {
    throw Object.assign(new Error("Invoice already exists for this job"), {
      statusCode: 409,
    });
  }

  const { subtotal, total } = calculateTotals(lineItems);

  return db.invoice.create({
    data: {
      tenantId: job.tenantId,
      jobId,
      status: InvoiceStatus.DRAFT,
      lineItems: lineItems as any,
      subtotal,
      taxRate: 0,
      total,
    },
    include: { job: { include: { contact: true } } },
  });
}

// ── updateInvoiceLineItems ────────────────────────────────────
// Operator reviews and corrects AI-generated line items.
// Only allowed while the invoice is still DRAFT.
export async function updateInvoiceLineItems(
  db: PrismaClient,
  invoiceId: string,
  lineItems: InvoiceLineItem[],
) {
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });

  if (!invoice) {
    throw Object.assign(new Error("Invoice not found"), { statusCode: 404 });
  }

  if (invoice.status !== InvoiceStatus.DRAFT) {
    throw Object.assign(new Error("Only DRAFT invoices can be edited"), {
      statusCode: 409,
    });
  }

  const { subtotal, total } = calculateTotals(lineItems);

  return db.invoice.update({
    where: { id: invoiceId },
    data: { lineItems: lineItems as any, subtotal, total },
    include: { job: { include: { contact: true } } },
  });
}

// ── sendInvoice ───────────────────────────────────────────────
// The "fire" action. Generates a Stripe payment link and
// texts it to the customer. Moves invoice DRAFT → SENT.
export async function sendInvoice(db: PrismaClient, invoiceId: string) {
  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      job: { include: { contact: true } },
    },
  });

  if (!invoice) {
    throw Object.assign(new Error("Invoice not found"), { statusCode: 404 });
  }

  if (invoice.status !== InvoiceStatus.DRAFT) {
    throw Object.assign(new Error("Only DRAFT invoices can be sent"), {
      statusCode: 409,
    });
  }

  const tenant = await db.tenant.findUnique({
    where: { id: invoice.tenantId },
  });
  if (!tenant) {
    throw Object.assign(new Error("Tenant not found"), { statusCode: 404 });
  }

  const contact = invoice.job.contact;
  if (!contact.phone) {
    throw Object.assign(new Error("Contact has no phone number on record"), {
      statusCode: 422,
    });
  }

  if (!tenant.twilioNumber){
    throw Object.assign(new Error("Tenant has no twilio number"), {
      statusCode: 422,
    })
  }

  // Generate the Stripe payment link
  const { paymentIntentId, paymentLink } = await createStripePaymentLink(
    invoice,
    tenant.name,
  );

  // Update the invoice with Stripe data and flip to SENT
  const updatedInvoice = await db.invoice.update({
    where: { id: invoiceId },
    data: {
      status: InvoiceStatus.SENT,
      stripePaymentIntentId: paymentIntentId,
      stripePaymentLink: paymentLink,
    },
  });

  // Mark the job as INVOICED
  await db.job.update({
    where: { id: invoice.jobId },
    data: { status: JobStatus.INVOICED },
  });

  // Text the payment link to the customer
  await sendPaymentSms({
    toPhone: contact.phone,
    fromPhone: tenant.twilioNumber,
    contactName: contact.name,
    tenantName: tenant.name,
    total: invoice.total,
    paymentLink,
  });

  return updatedInvoice;
}

// ── getInvoice ────────────────────────────────────────────────
export async function getInvoice(db: PrismaClient, invoiceId: string) {
  return db.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      job: {
        include: {
          contact: true,
          technician: { select: { id: true, name: true } },
        },
      },
    },
  });
}

// ── listInvoices ──────────────────────────────────────────────
export async function listInvoices(
  db: PrismaClient,
  options: {
    status?: InvoiceStatus;
    limit?: number;
    offset?: number;
  } = {},
) {
  const { status, limit = 50, offset = 0 } = options;
  const where: any = {};
  if (status) where.status = status;

  const [invoices, total] = await db.$transaction([
    db.invoice.findMany({
      where,
      include: { job: { include: { contact: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    db.invoice.count({ where }),
  ]);

  return { invoices, total, limit, offset };
}

// ── voidInvoice ───────────────────────────────────────────────
export async function voidInvoice(db: PrismaClient, invoiceId: string) {
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });

  if (!invoice) {
    throw Object.assign(new Error("Invoice not found"), { statusCode: 404 });
  }

  if (invoice.status === InvoiceStatus.PAID) {
    throw Object.assign(
      new Error("Cannot void a paid invoice — issue a refund instead"),
      { statusCode: 409 },
    );
  }

  // Cancel the Stripe payment intent if one exists
  if (invoice.stripePaymentIntentId) {
    try {
      await stripe.paymentIntents.cancel(invoice.stripePaymentIntentId);
    } catch (err: any) {
      // Already cancelled or captured — log and continue
      console.warn("[invoiceService] Could not cancel Stripe PI:", err.message);
    }
  }

  return db.invoice.update({
    where: { id: invoiceId },
    data: { status: InvoiceStatus.VOID },
  });
}

// ── handleStripeWebhook ───────────────────────────────────────
// Called when Stripe confirms a payment succeeded.
// This is the ONLY place we mark an invoice PAID.
// We verify the webhook signature first — without this,
// anyone could POST to this endpoint and mark invoices paid for free.
export async function handleStripeWebhook(db: PrismaClient, rawBody: Buffer, signature: string) {
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch (err: any) {
    throw Object.assign(
      new Error(`Stripe signature verification failed: ${err.message}`),
      { statusCode: 400 },
    );
  }

  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object as Stripe.PaymentIntent;
    const invoiceId = pi.metadata?.tradeagentInvoiceId;

    if (!invoiceId) return { received: true };

    const invoice = await db.invoice.findUnique({
      where: { id: invoiceId },
    });
    if (!invoice) return { received: true };

    await db.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.PAID, paidAt: new Date() },
    });
  }

  return { received: true };
}

// ── Internal helpers ──────────────────────────────────────────

async function createStripePaymentLink(
  invoice: { id: string; total: number; lineItems: any },
  tenantName: string,
): Promise<{ paymentIntentId: string; paymentLink: string }> {
  const lineItems = invoice.lineItems as InvoiceLineItem[];

  const stripeLineItems = [];
  for (const item of lineItems) {
    const product = await stripe.products.create({
      name: item.description,
    });
    const priceObj = await stripe.prices.create({
      product: product.id,
      unit_amount: Math.round(item.unitPrice * 100),
      currency: "usd",
    });
    stripeLineItems.push({
      price: priceObj.id,
      quantity: item.quantity,
    });
  }

  const paymentLinkObj = await stripe.paymentLinks.create({
    line_items: stripeLineItems,
    after_completion: {
      type: "hosted_confirmation",
      hosted_confirmation: {
        custom_message: `Thank you for choosing ${tenantName}!`,
      },
    },
    metadata: { tradeagentInvoiceId: invoice.id },
  });

  // Create a PaymentIntent so we can track payment via webhook
  const pi = await stripe.paymentIntents.create({
    amount: Math.round(invoice.total * 100),
    currency: "usd",
    metadata: {
      tradeagentInvoiceId: invoice.id,
      paymentLinkId: paymentLinkObj.id,
    },
  });

  return { paymentIntentId: pi.id, paymentLink: paymentLinkObj.url };
}

async function sendPaymentSms({
  toPhone,
  fromPhone,
  contactName,
  tenantName,
  total,
  paymentLink,
}: {
  toPhone: string;
  fromPhone: string;
  contactName: string | null;
  tenantName: string;
  total: number;
  paymentLink: string;
}) {
  const firstName = contactName?.split(" ")[0] || "there";
  const formattedTotal = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(total);

  await twilioClient.messages.create({
    to: toPhone,
    from: fromPhone,
    body:
      `Hi ${firstName}, this is ${tenantName}. ` +
      `Your invoice for ${formattedTotal} is ready. ` +
      `Pay securely here: ${paymentLink}`,
  });
}

function calculateTotals(lineItems: InvoiceLineItem[]) {
  // Always recalculate server-side — never trust totals from the client
  // or from the AI. The AI might hallucinate arithmetic.
  const subtotal =
    Math.round(
      lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0) *
        100,
    ) / 100;

  return { subtotal, total: subtotal };
}

// Obsolete placeholders removed.
