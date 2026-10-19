import * as QR from 'qrcode'
import * as fs from 'fs-extra'
import * as path from 'path'
import NodeCache from '@cacheable/node-cache'
import * as P from 'pino'
import { Boom } from '@hapi/boom'
import { handleMessagesUpsert } from './handlers/messages-upsert.handler'
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import axios from 'axios'
import { InjectRepository } from '@nestjs/typeorm'
import { Session } from 'src/session/entities/session.entity'
import { Repository } from 'typeorm'
import { WebhookService } from './webhook.service'
import { MessagesService } from 'src/messages/messages.service'

// Tipos importados dinámicamente
type WASocket = any
type ConnectionState = any

@Injectable()
export class WhatsappSessionManager implements OnModuleDestroy {
  private sessions = new Map<string, WASocket>()
  private qrCodes = new Map<string, string | null>()
  private connectionStates = new Map<string, 'open' | 'close' | 'connecting' | 'not_started'>()
  private qrAttempts = new Map<string, number>()
  private sessionPromises = new Map<string, Promise<void>>()
  private reconnectAttempts = new Map<string, number>()
  private reconnectTimers = new Map<string, NodeJS.Timeout>()
  private readonly MAX_QR_RETRIES = 6
  private readonly RECONNECT_BASE_DELAY_MS = 1_000
  private readonly RECONNECT_MAX_DELAY_MS = 60_000

  // Referencias a funciones de Baileys cargadas dinámicamente
  private makeWASocket: any
  private useMultiFileAuthState: any
  private fetchLatestBaileysVersion: any
  private makeCacheableSignalKeyStore: any
  private DisconnectReason: any
  private baileysLoaded = false

  constructor(
    @InjectRepository(Session)
    private readonly sessionRepository: Repository<Session>,
    private readonly messageService: MessagesService,
    private readonly webhook: WebhookService,
  ) {
    this.loadBaileys()
  }

  private logger = new Logger(WhatsappSessionManager.name)

  /** Al apagar (SIGTERM), cancela reconexiones pendientes y cierra los sockets sin hacer logout. */
  async onModuleDestroy() {
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer)
    this.reconnectTimers.clear()

    for (const [sessionId, sock] of this.sessions.entries()) {
      try {
        sock.ev?.removeAllListeners?.('connection.update')
        sock.end?.(undefined)
      } catch (error) {
        this.logger.warn(`[${sessionId}] error cerrando socket: ${error?.message}`)
      }
    }
    this.sessions.clear()
  }

  /**
   * Notifica al websocket externo si HOST_WEBSOCKET esta configurado.
   * Fire-and-forget: nunca arroja, asi un fallo del WS no rompe el flow de conexion.
   */
  private notifyWebsocket(path: string, body?: any) {
    const host = process.env.HOST_WEBSOCKET
    if (!host) return
    axios.post(`${host}${path}`, body, { timeout: 5000 })
      .catch(err => this.logger.warn(`websocket notify falló (${path}): ${err?.message}`))
  }

  /**
   * Carga dinámica de Baileys (ESM)
   */
  private async loadBaileys() {
    const importBaileys = new Function('specifier', 'return import(specifier)')
    const baileys = await importBaileys('@whiskeysockets/baileys')

    this.makeWASocket = baileys.default
    this.useMultiFileAuthState = baileys.useMultiFileAuthState
    this.fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion
    this.makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore
    this.DisconnectReason = baileys.DisconnectReason

    this.baileysLoaded = true
  }

  private async ensureBaileysLoaded() {
    if (this.baileysLoaded) return

    let attempts = 0
    while (!this.baileysLoaded && attempts < 50) {
      await new Promise(resolve => setTimeout(resolve, 100))
      attempts++
    }

    if (!this.baileysLoaded) {
      throw new Error('Timeout esperando que Baileys se cargue')
    }
  }

  /**
   * Arranque con promesa compartida: dos llamadas concurrentes esperan al mismo
   * intento. Si el intento falla ANTES de crear el socket (red caída al pedir la
   * versión, disco), la promesa se retira del mapa para que el siguiente intento
   * sea real y no vuelva a devolver el mismo rechazo.
   */
  async startSession(sessionId: string) {
    await this.ensureBaileysLoaded()

    if (this.sessionPromises.has(sessionId))
      return this.sessionPromises.get(sessionId)

    const promise = this._startSessionLogic(sessionId).catch(err => {
      this.sessionPromises.delete(sessionId)
      throw err
    })
    this.sessionPromises.set(sessionId, promise)

    return await promise
  }

  async _startSessionLogic(sessionId: string) {
    if ((this.qrAttempts.get(sessionId) ?? 0) >= this.MAX_QR_RETRIES) {
      this.notifyWebsocket(`/api/enviar-notificacion/${sessionId}/qr`, { qrImage: 'timeout' })
      this.logger.warn(`[${sessionId}] ❌ No se iniciará sesión por límite de QR`)
      this.sessionPromises.delete(sessionId)
      return
    }

    const currentState = this.connectionStates.get(sessionId)

    if (currentState === 'open') {
      this.logger.log(`[${sessionId}] ⚠️ Sesión ya activa, no se reinicia`)
      return
    }

    if (currentState === 'connecting')
      this.logger.log(`[${sessionId}] ⏳ Conectando... espera a que termine`)

    const authPath = path.resolve('sesiones', sessionId)
    await fs.ensureDir(authPath)

    const { state, saveCreds } = await this.useMultiFileAuthState(authPath)
    const { version } = await this.fetchLatestBaileysVersion()

    const sock = this.makeWASocket({
      version,
      logger: P({ level: 'fatal' }),
      auth: {
        creds: state.creds,
        keys: this.makeCacheableSignalKeyStore(state.keys, P({ level: 'fatal' }))
      },
      msgRetryCounterCache: new NodeCache() as any,
      generateHighQualityLinkPreview: true
    })

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }: ConnectionState) => {
      try {
        // Si este socket ya fue reemplazado por otro (logout + nuevo QR), sus eventos se
        // ignoran. Si simplemente ya no está en el mapa (logout en curso), el 'close' que
        // Baileys emite de forma asíncrona sí se procesa: es el que avisa al webhook.
        const actual = this.sessions.get(sessionId)
        if (actual && actual !== sock) {
          this.logger.debug(`[${sessionId}] evento de un socket antiguo ignorado (${connection ?? 'qr'})`)
          return
        }

        if (qr) {
          const attempts = this.qrAttempts.get(sessionId) ?? 0

          if (attempts >= this.MAX_QR_RETRIES) {
            this.logger.warn(`[${sessionId}] ❌ Límite de intentos de QR alcanzado`)
            this.qrCodes.set(sessionId, null)
            this.notifyWebsocket(`/api/enviar-notificacion/${sessionId}/qr`, { qrImage: 'timeout' })

            // logout() emite 'close' con loggedOut: esa rama limpia socket, BD y credenciales.
            await sock.logout()
            return
          }

          this.qrAttempts.set(sessionId, attempts + 1)
          const qrImage = await QR.toDataURL(qr)
          this.qrCodes.set(sessionId, qrImage)
          this.connectionStates.set(sessionId, 'connecting')

          await this.sessionRepository.update({ sessionId }, { status: 'connecting' })
          this.notifyWebsocket(`/api/enviar-notificacion/${sessionId}/qr`, { qrImage })
        }

        if (connection === 'close') {
          this.sessionPromises.delete(sessionId)

          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
          const shouldReconnect = statusCode !== this.DisconnectReason.loggedOut

          this.connectionStates.set(sessionId, 'close')

          this.logger.warn(`[${sessionId}] ❌ Desconectado. Reconnect: ${shouldReconnect} - Reason: ${statusCode}`)

          this.webhook.dispatch('session.close', { sessionId, statusCode, shouldReconnect })

          if (shouldReconnect) {
            this.connectionStates.set(sessionId, 'connecting')
            await this.sessionRepository.update({ sessionId }, { status: 'connecting' })
            this.scheduleReconnect(sessionId)
          } else {
            this.reconnectAttempts.delete(sessionId)
            if (this.sessions.get(sessionId) === sock) this.sessions.delete(sessionId)
            await this.sessionRepository.update({ sessionId }, { status: 'close', numberSession: '' })
            // Se quita la carpeta entera: así loadAllSessions no la ve como sesión a medias.
            await fs.remove(authPath).catch(() => undefined)
          }
        }

        if (connection === 'open') {
          // ORDEN IMPORTANTE: setear estado en memoria PRIMERO para que
          // la sesion quede usable aunque BD/websocket fallen.
          this.qrCodes.set(sessionId, null)
          this.connectionStates.set(sessionId, 'open')
          this.qrAttempts.delete(sessionId)
          this.reconnectAttempts.delete(sessionId)

          const meJid = sock?.authState?.creds?.me?.id

          if (meJid) {
            const bare = meJid.split('@')[0]
            const number = bare.includes(':') ? bare.split(':')[0] : bare

            try {
              await this.sessionRepository.update({ sessionId }, { status: 'open', numberSession: number })
            } catch (e) {
              this.logger.warn(`[${sessionId}] no se pudo actualizar BD: ${e?.message}`)
            }

            this.notifyWebsocket(`/api/enviar-notificacion/${sessionId}/open`)
            this.webhook.dispatch('session.open', { sessionId, number })
            this.logger.log(`[${sessionId}] ✅ Conectado - Número: ${number}`)
          } else {
            this.logger.warn(`[${sessionId}] ⚠️ Conectado pero no se pudo obtener el número`)
          }
        }
      } catch (error) {
        this.logger.error(`[${sessionId}] Error en connection.update:`, error)
      }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', (upsert: any) =>
      handleMessagesUpsert(sock, upsert, sessionId, this.webhook)
    )

    sock.ev.on('messages.update', (updates: any[]) =>
      this.handleMessagesUpdate(sessionId, updates),
    )

    this.sessions.set(sessionId, sock)
  }

  private scheduleReconnect(sessionId: string) {
    const existing = this.reconnectTimers.get(sessionId)
    if (existing) clearTimeout(existing)

    const attempt = (this.reconnectAttempts.get(sessionId) ?? 0) + 1
    this.reconnectAttempts.set(sessionId, attempt)

    const base = Math.min(
      this.RECONNECT_MAX_DELAY_MS,
      this.RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1),
    )
    // jitter +-20 % para que varias sesiones no reconecten a la vez
    const delay = Math.round(base * (0.8 + Math.random() * 0.4))

    this.logger.log(`[${sessionId}] 🔁 Reintento #${attempt} en ${delay}ms`)

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(sessionId)
      this.startSession(sessionId).catch(err =>
        this.logger.warn(`[${sessionId}] reconnect falló: ${err?.message}`),
      )
    }, delay)
    this.reconnectTimers.set(sessionId, timer)
  }

  private async handleMessagesUpdate(sessionId: string, updates: any[]) {
    if (!updates?.length) return

    for (const u of updates) {
      const waId = u?.key?.id
      const status = u?.update?.status
      if (!waId || status === undefined) continue

      const statusName = this.mapStatus(status)

      this.webhook.dispatch('message.update', {
        sessionId,
        messageId: waId,
        remoteJid: u.key?.remoteJid,
        status: statusName,
      })

      try {
        // Solo avanza el estado (nunca read -> sent) y solo dentro de esta sesión.
        await this.messageService.applyAck(sessionId, waId, statusName)
      } catch (err: any) {
        this.logger.warn(`[${sessionId}] no se pudo actualizar status de ${waId}: ${err?.message}`)
      }
    }
  }

  private mapStatus(code: number): string {
    // Baileys WAMessageStatus: 0=ERROR, 1=PENDING, 2=SERVER_ACK, 3=DELIVERY_ACK, 4=READ, 5=PLAYED
    const map: Record<number, string> = {
      0: 'error',
      1: 'pending',
      2: 'sent',
      3: 'delivered',
      4: 'read',
      5: 'played',
    }
    return map[code] ?? `unknown(${code})`
  }

  async getQR(sessionId: string): Promise<string | null> {
    return this.qrCodes.get(sessionId) || null
  }

  async waitForQR(sessionId: string, timeout = 10000): Promise<string | null> {
    const pollInterval = 200
    let waited = 0

    while (!this.qrCodes.get(sessionId) && waited < timeout) {
      await new Promise(resolve => setTimeout(resolve, pollInterval))
      waited += pollInterval
    }

    return this.qrCodes.get(sessionId) || null
  }

  getSessionState(sessionId: string) {
    return this.connectionStates.get(sessionId) || 'not_started'
  }

  resetQrAttempts(sessionId: string) {
    this.qrAttempts.set(sessionId, 0)
  }

  getSocket(sessionId: string): WASocket | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Al arrancar, levanta las sesiones que tienen credenciales en disco Y siguen
   * activas y sin borrar en la BD. Las carpetas huérfanas se dejan y se avisa.
   */
  async loadAllSessions() {
    await this.ensureBaileysLoaded()

    const basePath = path.resolve('sesiones')
    const exists = await fs.pathExists(basePath)
    if (!exists) return

    const sessionDirs = await fs.readdir(basePath)

    for (const dir of sessionDirs) {
      const sessionPath = path.join(basePath, dir)
      const stat = await fs.stat(sessionPath)
      if (!stat.isDirectory()) continue

      const files = await fs.readdir(sessionPath)
      if (files.length === 0) {
        this.logger.warn(`[${dir}] ⚠️ Carpeta vacía, se omite inicio de sesión`)
        continue
      }

      const session = await this.sessionRepository.findOne({ where: { sessionId: dir } })
      if (!session) {
        this.logger.warn(`[${dir}] ⚠️ Hay credenciales en disco pero la sesión no existe en BD (o está borrada); no se inicia`)
        continue
      }
      if (!session.isActive) {
        this.logger.warn(`[${dir}] ⚠️ Sesión inactiva en BD; no se inicia`)
        continue
      }

      try {
        await this.startSession(dir)
      } catch (error) {
        this.logger.error(`[${dir}] no se pudo iniciar al arrancar: ${error?.message}`)
      }
    }
  }

  getAllStates() {
    return Array.from(this.connectionStates.entries())
      .map(([id, state]) => ({ sessionId: id, state }))
  }

  /**
   * Cierre explícito: cancela reconexiones programadas, olvida la promesa de
   * arranque y hace logout en WhatsApp. Las credenciales las borra el handler
   * de 'close' (loggedOut) o, si no hay socket, aquí mismo.
   */
  async logout(sessionId: string) {
    const timer = this.reconnectTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.reconnectTimers.delete(sessionId)
    this.reconnectAttempts.delete(sessionId)
    this.sessionPromises.delete(sessionId)

    const sock = this.sessions.get(sessionId)

    this.connectionStates.set(sessionId, 'close')
    this.qrCodes.delete(sessionId)
    this.qrAttempts.delete(sessionId)

    if (sock) {
      try {
        await sock.logout()
      } catch (e) {
        this.logger.warn(`[${sessionId}] error en logout():`, e)
      }
      this.sessions.delete(sessionId)
    }

    // Idempotente: si el handler de 'close' ya la borró, no hay nada que hacer.
    await fs.remove(path.resolve('sesiones', sessionId)).catch(() => undefined)

    try {
      await this.sessionRepository.update({ sessionId }, { status: 'close', numberSession: '' })
    } catch (e) {
      this.logger.warn(`[${sessionId}] no se pudo actualizar BD tras logout: ${e?.message}`)
    }

    this.logger.log(`[${sessionId}] 🔒 Sesión cerrada`)
    return { status: 'closed' }
  }
}
