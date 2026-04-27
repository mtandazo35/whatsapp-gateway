import { Logger } from '@nestjs/common'

const logger = new Logger('MessagesUpsertHandler')

/**
 * Maneja el evento messages.upsert de Baileys.
 * Aquí se centralizará toda la lógica de recepción de mensajes,
 * incluyendo integración con IA u otros procesadores.
 *
 * @param sock     Socket de la sesión activa
 * @param upsert   Payload del evento messages.upsert
 * @param sessionId Identificador de la sesión
 */
export async function handleMessagesUpsert(
  sock: any,
  upsert: any,
  sessionId: string
): Promise<void> {
  try {
    if (upsert.type === 'notify') {
      for (const msg of upsert.messages) {
        await processMessage(sock, msg, upsert, sessionId)
      }
    }
  } catch (error) {
    logger.error(`[${sessionId}] Error en handleMessagesUpsert:`, error)
  }
}

/**
 * Procesa un mensaje individual recibido.
 */
async function processMessage(
  sock: any,
  msg: any,
  upsert: any,
  sessionId: string
): Promise<void> {
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text

  if (!text) return

  const remoteJid: string = msg.key?.remoteJid ?? ''
  const fromMe: boolean = msg.key?.fromMe ?? false

  logger.log(`[${sessionId}] Mensaje de ${remoteJid}: "${text}"`)

  // Resincronización de placeholder
  if (text === 'requestPlaceholder' && !upsert.requestId) {
    const importBaileys = new Function('s', 'return import(s)')
    const { generateMessageIDV2 } = await importBaileys('@whiskeysockets/baileys')
    const messageId = await sock.requestPlaceholderResend(msg.key)
    logger.debug(`[${sessionId}] requested placeholder resync id: ${messageId}`)
    return
  }

  // Resincronización de historial bajo demanda
  if (text === 'onDemandHistSync') {
    const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp!)
    logger.debug(`[${sessionId}] requested on-demand history resync id: ${messageId}`)
    return
  }

  // Ignorar mensajes propios o de newsletters
  if (fromMe) return

  const importBaileys = new Function('s', 'return import(s)')
  const { isJidNewsletter } = await importBaileys('@whiskeysockets/baileys')

  if (isJidNewsletter(remoteJid)) return

  // TODO: aquí puedes agregar integración con IA, base de datos, etc.
  await handleIncomingMessage(sock, msg, text, remoteJid, sessionId)
}

/**
 * Punto de entrada para mensajes entrantes de usuarios reales.
 * Aquí se conectará la IA u otra lógica de negocio.
 */
async function handleIncomingMessage(
  sock: any,
  msg: any,
  text: string,
  remoteJid: string,
  sessionId: string
): Promise<void> {
  logger.log(`[${sessionId}] Mensaje entrante de ${remoteJid}: "${text}"`)

  // TODO: integrar IA, flujos de conversación, etc.
  // await sock.sendMessage(remoteJid, { text: `Hola! Recibí tu mensaje: "${text}"` }, { quoted: msg })
}
