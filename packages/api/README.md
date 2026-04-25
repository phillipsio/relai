# @relai/api

Fastify REST API. The single source of truth — all packages communicate through this.

## Running

```bash
cp ../../.env.example ../../.env  # fill in values
pnpm dev
```

Default port: `3000`. Override with `API_PORT`.

## Routes

All routes require `Authorization: Bearer <API_SECRET>`.

```
GET  /health

POST /projects
GET  /projects/:id

POST /agents
PUT  /agents/:id/heartbeat
GET  /agents?projectId=

POST /tasks
GET  /tasks?projectId=&status=&assignedTo=
GET  /tasks/:id
PUT  /tasks/:id

POST /threads
GET  /threads?projectId=

POST /threads/:id/messages
GET  /threads/:id/messages
PUT  /threads/:id/messages/read
GET  /messages/unread?agentId=
```

## Response envelope

Success: `{ "data": ... }`
Error: `{ "error": { "code": "...", "message": "..." } }`
