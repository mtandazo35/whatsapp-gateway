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

/**
 * Reenvía mensajes entrantes al webhook.
 *
 * Se eliminaron las ramas de ejemplo de Baileys que, ante los textos literales
 * "requestPlaceholder" y "onDemandHistSync", pedían reenvíos de placeholder y
 * sincronización de historial. Las ejecutaba cualquier contacto y son justo el
 * vector de GHSA-qvv5-jq5g-4cgg. Si algún día hace falta resincronizar, debe
 * ser una operación administrativa autenticada, no una reacción a un texto.
 */
export async function handleMessagesUpsert(
  _sock: any,
  upsert: any,
  sessionId: string,
  webhook: WebhookService,
): Promise<void> {
  try {
    if (upsert.type !== 'notify') return

    // Mitigación recomendada por el aviso: el gateway no solicita historial bajo
    // demanda, así que un upsert con requestId no es nuestro y se descarta.
    if (upsert.requestId) {
      logger.warn(`[${sessionId}] upsert con requestId inesperado descartado`)
      return
    }

    for (const msg of upsert.messages) {
      await processMessage(msg, sessionId, webhook)
    }
  } catch (error) {
    logger.error(`[${sessionId}] Error en handleMessagesUpsert:`, error)
  }
}

async function processMessage(
  msg: any,
  sessionId: string,
  webhook: WebhookService,
): Promise<void> {
  const remoteJid: string = msg.key?.remoteJid ?? ''
  const fromMe: boolean = msg.key?.fromMe ?? false

  if (fromMe) return

  const { isJidNewsletter } = await loadBaileysHelpers()
  if (isJidNewsletter(remoteJid)) return

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    null

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
