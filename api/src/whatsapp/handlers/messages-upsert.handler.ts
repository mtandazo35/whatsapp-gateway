import { Logger } from '@nestjs/common'
import { WebhookService } from '../webhook.service'

const logger = new Logger('MessagesUpsertHandler')

let baileysHelpers: { isJidNewsletter: (jid: string) => boolean } | null = null

async function loadBaileysHelpers() {
  if (baileysHelpers) return baileysHelpers
  const importBaileys = new Function('s', 'return import(s)')
  const mod = await importBaileys('@whiskeysockets/baileys')
  baileysHelpers = { isJidNewsletter: mod.isJidNewsletter }
  return baileysHelpers
}

export async function handleMessagesUpsert(
  sock: any,
  upsert: any,
  sessionId: string,
  webhook: WebhookService,
): Promise<void> {
  try {
    if (upsert.type !== 'notify') return

    for (const msg of upsert.messages) {
      await processMessage(sock, msg, upsert, sessionId, webhook)
    }
  } catch (error) {
    logger.error(`[${sessionId}] Error en handleMessagesUpsert:`, error)
  }
}

async function processMessage(
  sock: any,
  msg: any,
  upsert: any,
  sessionId: string,
  webhook: WebhookService,
): Promise<void> {
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    null

  const remoteJid: string = msg.key?.remoteJid ?? ''
  const fromMe: boolean = msg.key?.fromMe ?? false

  if (text === 'requestPlaceholder' && !upsert.requestId) {
    const messageId = await sock.requestPlaceholderResend(msg.key)
    logger.debug(`[${sessionId}] requested placeholder resync id: ${messageId}`)
    return
  }

  if (text === 'onDemandHistSync') {
    const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp!)
    logger.debug(`[${sessionId}] requested on-demand history resync id: ${messageId}`)
    return
  }

  if (fromMe) return

  const { isJidNewsletter } = await loadBaileysHelpers()
  if (isJidNewsletter(remoteJid)) return

  const number = remoteJid.split('@')[0]?.split(':')[0] ?? ''
  const messageType = Object.keys(msg.message ?? {})[0] ?? 'unknown'

  logger.log(`[${sessionId}] Mensaje entrante de ${remoteJid} (${messageType})`)

  await webhook.dispatch('message.incoming', {
    sessionId,
    messageId: msg.key?.id,
    from: number,
    fromJid: remoteJid,
    fromMe,
    pushName: msg.pushName ?? null,
    timestamp: Number(msg.messageTimestamp ?? 0),
    type: messageType,
    text,
  })
}
