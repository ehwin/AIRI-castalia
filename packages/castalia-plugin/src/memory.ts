import type { DatabaseSync } from 'node:sqlite'

/** Durable Castalia memory record shared with AIRI's existing memory store. */
export interface CastaliaMemoryEntry {
  /** 库里的行 id（castalia bank 的记忆有自己的 id；纯本地 sqlite 仓库没有）。删除时优先用它。 */
  id?: string
  name: string
  description: string
  body: string
  persona?: string
  updatedAt: number
}

/** A small storage adapter over the main-process SQLite database. */
export function createCastaliaMemoryRepository(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS castalia_memories (
      name TEXT NOT NULL,
      persona TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL,
      body TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (name, persona)
    )
  `)

  const listStatement = database.prepare(`
    SELECT name, description, body, persona, updated_at
    FROM castalia_memories
    ORDER BY name COLLATE NOCASE, persona COLLATE NOCASE
  `)
  const saveStatement = database.prepare(`
    INSERT INTO castalia_memories (name, persona, description, body, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (name, persona) DO UPDATE SET
      description = excluded.description,
      body = excluded.body,
      updated_at = excluded.updated_at
  `)
  const forgetStatement = database.prepare('DELETE FROM castalia_memories WHERE name = ? AND persona = ?')

  return {
    list(): CastaliaMemoryEntry[] {
      return listStatement.all().map((row) => {
        const memory = row as {
          name: string
          description: string
          body: string
          persona: string
          updated_at: number
        }
        return {
          name: memory.name,
          description: memory.description,
          body: memory.body,
          ...(memory.persona ? { persona: memory.persona } : {}),
          updatedAt: memory.updated_at,
        }
      })
    },

    save(entry: CastaliaMemoryEntry): void {
      const name = entry.name.trim()
      const body = entry.body.trim()
      if (!name || !body)
        throw new TypeError('Castalia memory name and body must not be empty')
      saveStatement.run(name, entry.persona ?? '', entry.description.trim(), body, Math.trunc(entry.updatedAt))
    },

    forget(entry: Pick<CastaliaMemoryEntry, 'name' | 'persona'>): boolean {
      // save() trims the name, so forget() must trim it the same way.
      return forgetStatement.run(entry.name.trim(), entry.persona ?? '').changes > 0
    },
  }
}
