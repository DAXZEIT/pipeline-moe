import { describe, it, expect } from 'vitest'
import { SEED_PERSONAS } from '../personas.js'
import fs from 'node:fs'
import path from 'node:path'

describe('New features smoke test', () => {
  it('all 7 personas have compactionInstructions (10-500 chars)', () => {
    for (const p of SEED_PERSONAS) {
      const ci = p.compactionInstructions
      expect(ci, `${p.id} missing compactionInstructions`).toBeDefined()
      expect(typeof ci).toBe('string')
      expect(ci!.length, `${p.id} too short`).toBeGreaterThan(10)
      expect(ci!.length, `${p.id} too long`).toBeLessThanOrEqual(500)
    }
  })

  it('compaction instructions are role-specific (not identical)', () => {
    const instructions = SEED_PERSONAS.map(p => p.compactionInstructions!)
    const unique = new Set(instructions)
    expect(unique.size).toBe(SEED_PERSONAS.length)
  })

  it('formatReceipt and work_receipt in room.ts', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../room.ts'), 'utf8')
    expect(source).toContain('function formatReceipt')
    expect(source).toContain('work_receipt')
    expect(source).toContain('sendCustomMessage')
  })

  it('Participant has new methods', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../participant.ts'), 'utf8')
    expect(source).toContain('async compact(')
    expect(source).toContain('compactionInstructions')
    expect(source).toContain('async sendCustomMessage(')
    expect(source).toContain('exportToJsonl()')
    expect(source).toContain('getLastAssistantText()')
    expect(source).toContain('setSessionName(')
  })

  it('server.ts has JSONL endpoint and compactionInstructions validation', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8')
    expect(source).toContain('/api/participants/:id/export-jsonl')
    expect(source).toContain('compactionInstructions')
  })

  it('config.ts has PIPELINE_CORS_ORIGINS', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../config.ts'), 'utf8')
    expect(source).toContain('PIPELINE_CORS_ORIGINS')
    expect(source).toContain('corsOrigins')
  })
})
