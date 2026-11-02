// Meridian Prime market relay — fans out desk broadcasts to Socket.IO
// clients (the operator console). The Next.js runtime POSTs events to
// /internal/broadcast; every connected client receives market + activity.

import { createServer } from 'http'
import { Server } from 'socket.io'

const PORT = Number(process.env.RELAY_PORT || 3003)
const TOKEN = process.env.RELAY_TOKEN || 'prime-relay'

const httpServer = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/internal/broadcast') {
    if ((req.headers['x-relay-token'] ?? '') !== TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'bad token' }))
      return
    }
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      try {
        const { event, payload } = JSON.parse(body)
        if (typeof event !== 'string' || event.length === 0) throw new Error('missing event')
        io.emit(event, payload ?? null)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, clients: io.engine.clientsCount }))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'bad payload' }))
      }
    })
    return
  }
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, clients: io.engine.clientsCount }))
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: 'not found' }))
})

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60_000,
  pingInterval: 25_000,
  maxHttpBufferSize: 2e6,
})

io.on('connection', (socket) => {
  socket.join('desk')
  socket.on('error', (error) => {
    console.error(`socket error (${socket.id}):`, error)
  })
})

httpServer.listen(PORT, () => {
  console.log(`meridian prime relay running on port ${PORT}`)
})

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0))
})
