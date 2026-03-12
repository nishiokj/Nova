import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

type EncryptedSecretPayload = {
  alg: 'aes-256-gcm'
  iv: string
  tag: string
  ciphertext: string
}

function deriveKey(masterKey: string): Buffer {
  return createHash('sha256').update(masterKey, 'utf8').digest()
}

export function encryptSecretValue(masterKey: string, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(masterKey), iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const payload: EncryptedSecretPayload = {
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return JSON.stringify(payload)
}

export function decryptSecretValue(masterKey: string, payloadText: string): string {
  const payload = JSON.parse(payloadText) as Partial<EncryptedSecretPayload>
  if (
    payload.alg !== 'aes-256-gcm'
    || typeof payload.iv !== 'string'
    || typeof payload.tag !== 'string'
    || typeof payload.ciphertext !== 'string'
  ) {
    throw new Error('invalid encrypted secret payload')
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(masterKey),
    Buffer.from(payload.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ])
  return plaintext.toString('utf8')
}
