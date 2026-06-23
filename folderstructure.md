This is the folder structure of the codebase. It will be updated whenever a new file is added. 

tradeagent/
├── package.json
├── tsconfig.json
├── prisma.config.ts
├── .env
├── db/
│   └── prisma/
│       ├── schema.prisma
│       └── seed.ts
└── apps/
    └── api/
        ├── package.json
        └── src/
            ├── index.ts
            ├── plugins/
            │   ├── db.ts
            │   └── db.d.ts
            ├── routes/
            │   ├── health.ts
            │   ├── contacts.ts
            │   ├── jobs.ts
            │   ├── invoices.ts
            │   └── technicians.ts
            └── services/
                ├── contactService.ts
                ├── jobService.ts
                ├── technicianService.ts
                ├── invoiceService.ts
                └── transcriptionService.ts