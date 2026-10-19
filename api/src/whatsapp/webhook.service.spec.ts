import { validateWebhookUrl } from './webhook.service'

describe('validateWebhookUrl', () => {
  it('vacío = desactivado, válido', () => {
    expect(validateWebhookUrl('', false).ok).toBe(true)
  })
  it('https siempre vale', () => {
    expect(validateWebhookUrl('https://crm.ejemplo.com/hook', false).ok).toBe(true)
  })
  it('http solo con WEBHOOK_ALLOW_HTTP', () => {
    expect(validateWebhookUrl('http://10.0.0.5/hook', false).ok).toBe(false)
    expect(validateWebhookUrl('http://10.0.0.5/hook', true).ok).toBe(true)
  })
  it('otros esquemas y basura se rechazan', () => {
    expect(validateWebhookUrl('ftp://x/y', true).ok).toBe(false)
    expect(validateWebhookUrl('no es url', true).ok).toBe(false)
  })
})
