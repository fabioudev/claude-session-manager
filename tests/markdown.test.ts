import { describe, expect, it } from 'vitest'
import { type MarkdownBlock, parseInline, parseMarkdown } from '../web/src/components/Markdown.js'

function kinds(blocks: MarkdownBlock[]): string[] {
  return blocks.map((block) => block.type)
}

function textOf(nodes: ReturnType<typeof parseInline>): string {
  return nodes
    .map((node) => {
      if (node.type === 'text' || node.type === 'code') return node.value
      if (node.type === 'break') return '\n'
      if ('children' in node) return textOf(node.children)
      return ''
    })
    .join('')
}

describe('parseInline', () => {
  it('keeps plain text as one node', () => {
    expect(parseInline('Erledigt — die Registrierung ist aus.')).toEqual([
      { type: 'text', value: 'Erledigt — die Registrierung ist aus.' },
    ])
  })

  it('splits bold, italic and inline code', () => {
    const nodes = parseInline('Ein **fetter** und *kursiver* `code` Wert')
    expect(nodes.map((node) => node.type)).toEqual([
      'text',
      'strong',
      'text',
      'em',
      'text',
      'code',
      'text',
    ])
    expect(textOf(nodes)).toBe('Ein fetter und kursiver code Wert')
  })

  it('leaves snake_case and file names alone', () => {
    expect(textOf(parseInline('signups_allowed wird in src/config.rs gelesen'))).toBe(
      'signups_allowed wird in src/config.rs gelesen',
    )
  })

  it('does not treat two asterisks with spaces as emphasis', () => {
    expect(parseInline('2 * 3 * 4').some((node) => node.type === 'em')).toBe(false)
  })

  it('renders links and drops unsafe schemes', () => {
    const safe = parseInline('siehe [Docs](https://example.com/a)')
    expect(safe.find((node) => node.type === 'link')).toMatchObject({
      type: 'link',
      href: 'https://example.com/a',
    })

    const unsafe = parseInline('[klick](javascript:alert(1))')
    expect(unsafe.some((node) => node.type === 'link')).toBe(false)
    expect(textOf(unsafe)).toContain('klick')
  })

  it('linkifies bare urls', () => {
    const nodes = parseInline('unter https://vault.example.de/api/config nachsehen')
    expect(nodes.find((node) => node.type === 'link')).toMatchObject({
      type: 'link',
      href: 'https://vault.example.de/api/config',
    })
  })

  it('keeps code spans literal', () => {
    const nodes = parseInline('`**nicht fett**`')
    expect(nodes).toEqual([{ type: 'code', value: '**nicht fett**' }])
  })
})

describe('parseMarkdown', () => {
  it('returns an empty document for blank input', () => {
    expect(parseMarkdown('   \n\n')).toEqual([])
  })

  it('groups consecutive lines into one paragraph', () => {
    const blocks = parseMarkdown('erste Zeile\nzweite Zeile\n\ndritter Absatz')
    expect(kinds(blocks)).toEqual(['paragraph', 'paragraph'])
    expect(textOf((blocks[0] as { children: ReturnType<typeof parseInline> }).children)).toBe(
      'erste Zeile\nzweite Zeile',
    )
  })

  it('parses headings with their level', () => {
    const blocks = parseMarkdown('# Eins\n## Zwei\n###### Sechs')
    expect(blocks).toMatchObject([
      { type: 'heading', level: 1 },
      { type: 'heading', level: 2 },
      { type: 'heading', level: 6 },
    ])
  })

  it('parses fenced code blocks and keeps their body verbatim', () => {
    const source = '```bash\nis_signup_disabled = !signups_allowed\n```\nfertig'
    const blocks = parseMarkdown(source)
    expect(blocks[0]).toEqual({
      type: 'code',
      lang: 'bash',
      value: 'is_signup_disabled = !signups_allowed',
    })
    expect(blocks[1]).toMatchObject({ type: 'paragraph' })
  })

  it('leaves an unclosed fence as a code block to the end', () => {
    const blocks = parseMarkdown('```\nkein Ende')
    expect(blocks).toEqual([{ type: 'code', lang: null, value: 'kein Ende' }])
  })

  it('parses bullet lists and nested items', () => {
    const blocks = parseMarkdown('- eins\n- zwei\n  - zwei-a\n- drei')
    expect(blocks).toHaveLength(1)
    const list = blocks[0] as Extract<MarkdownBlock, { type: 'list' }>
    expect(list.ordered).toBe(false)
    expect(list.items.map((item) => textOf(item.children))).toEqual(['eins', 'zwei', 'drei'])
    expect(list.items[1].nested[0]).toMatchObject({ type: 'list', ordered: false })
  })

  it('parses ordered lists with a start offset', () => {
    const blocks = parseMarkdown('3. drei\n4. vier')
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: true, start: 3 })
  })

  it('does not confuse a horizontal rule with a list', () => {
    expect(parseMarkdown('---')).toEqual([{ type: 'rule' }])
  })

  it('parses blockquotes as nested blocks', () => {
    const blocks = parseMarkdown('> **Hinweis**\n> zweite Zeile')
    expect(blocks[0]).toMatchObject({ type: 'quote' })
  })

  it('parses gfm tables', () => {
    const blocks = parseMarkdown('| Key | Wert |\n| --- | --- |\n| a | 1 |\n| b | 2 |')
    expect(blocks[0]).toMatchObject({ type: 'table' })
    const table = blocks[0] as Extract<MarkdownBlock, { type: 'table' }>
    expect(table.head).toHaveLength(2)
    expect(table.rows).toHaveLength(2)
    expect(textOf(table.rows[1][1])).toBe('2')
  })

  it('handles a real assistant reply', () => {
    const reply = [
      'Erledigt — die Selbstregistrierung ist aus.',
      '',
      '**Was jetzt gilt:**',
      '',
      '- `/api/config` → `disableUserRegistration: true`',
      '- Signup-Versuch → `400`',
      '',
      '```',
      'is_signup_disabled = (!signups_allowed && !invitations_allowed)',
      '```',
    ].join('\n')
    expect(kinds(parseMarkdown(reply))).toEqual(['paragraph', 'paragraph', 'list', 'code'])
  })
})
