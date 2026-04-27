import * as QR from 'qrcode'
import * as fs from 'fs-extra'
import * as path from 'path'
import NodeCache from '@cacheable/node-cache'
import * as P from 'pino'
import { Boom } from '@hapi/boom'
import { deleteFilesInFolder } from './utils/files-utils'
import { handleMessagesUpsert } from './handlers/messages-upsert.handler'
import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { InjectRepository } from '@nestjs/typeorm'
import { Session } from 'src/session/entities/session.entity'
import { Repository } from 'typeorm'

// Tipos importados dinámicamente
type WASocket = any
type DisconnectReason = any
type ConnectionState = any

@Injectable()
export class WhatsappSessionManager {
  private sessions = new Map<string, WASocket>()
  private qrCodes = new Map<string, string | null>()
  private connectionStates = new Map<string, 'open' | 'close' | 'connecting' | 'not_started'>()
  private qrAttempts = new Map<string, number>()
  private sessionPromises = new Map<string, Promise<void>>()
  private readonly MAX_QR_RETRIES = 6

  // Referencias a funciones de Baileys cargadas dinámicamente
  private makeWASocket: any
  private useMultiFileAuthState: any
  private fetchLatestBaileysVersion: any
  private makeCacheableSignalKeyStore: any
  private DisconnectReason: any
  private baileysLoaded = false

  constructor(
    @InjectRepository(Session)
    private readonly sessionRepository: Repository<Session>
  ) {
    // Cargar Baileys al inicializar el servicio
    this.loadBaileys()
  }

  private logger = new Logger(WhatsappSessionManager.name)

  /**
   * Notifica al websocket externo si HOST_WEBSOCKET esta configurado.
   * Fire-and-forget: nunca arroja, asi un fallo del WS no rompe el flow
   * de conexion (que es lo que dejaba connectionStates desincronizado).
   */
  private notifyWebsocket(path: string, body?: any) {
    const host = process.env.HOST_WEBSOCKET
    if (!host) return
    axios.post(`${host}${path}`, body)
      .catch(err => this.logger.warn(`websocket notify falló (${path}): ${err?.message}`))
  }

  /**
   * Carga dinámica de Baileys (ESM)
   */
  private async loadBaileys() {
    try {
      // Usando Function constructor para evitar que TypeScript transpile el import()
      const importBaileys = new Function('specifier', 'return import(specifier)')
      const baileys = await importBaileys('@whiskeysockets/baileys')

      this.makeWASocket = baileys.default
      this.useMultiFileAuthState = baileys.useMultiFileAuthState
      this.fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion
      this.makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore
      this.DisconnectReason = baileys.DisconnectReason

      this.baileysLoaded = true
    } catch (error) {
      throw error
    }
  }

  /**
   * Espera a que Baileys esté cargado
   */
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

  async startSession(sessionId: string) {
    await this.ensureBaileysLoaded()

    if (this.sessionPromises.has(sessionId))
      return this.sessionPromises.get(sessionId)

    const promise = this._startSessionLogic(sessionId)
    this.sessionPromises.set(sessionId, promise)

    return await promise
  }

  async _startSessionLogic(sessionId: string) {
    if ((this.qrAttempts.get(sessionId) ?? 0) >= this.MAX_QR_RETRIES) {
      this.notifyWebsocket(`/api/enviar-notificacion/${sessionId}/qr`, { qrImage: 'timeout' })
      this.logger.warn(`[${sessionId}] ❌ No se iniciará sesión por límite de QR`)
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
        if (qr) {
          const attempts = this.qrAttempts.get(sessionId) ?? 0

          if (attempts >= this.MAX_QR_RETRIES) {
            this.logger.warn(`[${sessionId}] ❌ Límite de intentos de QR alcanzado`)
            this.qrCodes.set(sessionId, null)

            await sock.logout()

            this.sessions.delete(sessionId)
            this.connectionStates.set(sessionId, 'close')
            this.notifyWebsocket(`/api/enviar-notificacion/${sessionId}/qr`, { qrImage: 'timeout' })
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

          if (shouldReconnect) {
            this.connectionStates.set(sessionId, 'connecting')

            await Promise.all([
              this.sessionRepository.update({ sessionId }, { status: 'connecting' }),
              this.startSession(sessionId)
            ])
          } else {
            await this.sessionRepository.update({ sessionId }, { status: 'close', numberSession: '' })
            deleteFilesInFolder(authPath)
          }
        }

        if (connection === 'open') {
          // ORDEN IMPORTANTE: setear estado en memoria PRIMERO para que
          // la sesion quede usable aunque BD/websocket fallen.
          this.qrCodes.set(sessionId, null)
          this.connectionStates.set(sessionId, 'open')
          this.qrAttempts.delete(sessionId)

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
      handleMessagesUpsert(sock, upsert, sessionId)
    )

    this.sessions.set(sessionId, sock)
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

  async loadAllSessions() {
    await this.ensureBaileysLoaded()

    const basePath = path.resolve('sesiones')
    const exists = await fs.pathExists(basePath)
    if (!exists) return

    const sessionDirs = await fs.readdir(basePath)

    for (const dir of sessionDirs) {
      const sessionPath = path.join(basePath, dir)
      const stat = await fs.stat(sessionPath)

      if (stat.isDirectory()) {
        const files = await fs.readdir(sessionPath)
        if (files.length === 0) {
          this.logger.warn(`[${dir}] ⚠️ Carpeta vacía, se omite inicio de sesión`)
          continue
        }
        await this.startSession(dir)
      }
    }
  }

  getAllStates() {
    return Array.from(this.connectionStates.entries())
      .map(([id, state]) => ({ sessionId: id, state }))
  }

  async logout(sessionId: string) {
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

    this.logger.log(`[${sessionId}] 🔒 Sesión cerrada y archivos limpiados`)
    return { status: 'closed' }
  }
}