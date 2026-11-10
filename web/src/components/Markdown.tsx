import { type ReactNode, useMemo } from 'react'

/**
 * A deliberately small Markdown renderer for the replies shown in the session
 * detail view. Claude Code answers are mostly short: paragraphs, bullet lists,
 * fenced code and the occasional table. Rendering them as plain text leaves
 * `**bold**` and fences on screen, so we parse the subset that actually shows
 * up — without pulling in a full Markdown engine and without ever writing
 * untrusted HTML into the DOM (everything becomes React nodes).
 */

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'del'; children: InlineNode[] }
  | { type: 'link'; href: string; children: InlineNode[] }
  | { type: 'break' }

export type MarkdownListItem = {
  children: InlineNode[]
  nested: MarkdownBlock[]
}

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: InlineNode[] }
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'code'; lang: string | null; value: string }
  | { type: 'list'; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { type: 'quote'; blocks: MarkdownBlock[] }
  | { type: 'table'; head: InlineNode[][]; rows: InlineNode[][][] }
  | { type: 'rule' }

const SAFE_HREF = /^(https?:\/\/|mailto:)/i
const BARE_URL = /^https?:\/\/[^\s<>()[\]]+/i
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const FENCE = /^(\s*)(```+|~~~+)\s*([^`\s]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function indentOf(line: string): number {
  const match = line.match(/^[ \t]*/)
  return match ? match[0].replace(/\t/g, '  ').length : 0
}

function isTableStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? ''
  const next = lines[index + 1] ?? ''
  return line.includes('|') && TABLE_DIVIDER.test(next) && next.includes('-')
}

function safeHref(value: string): string | null {
  const href = value.trim()
  return SAFE_HREF.test(href) ? href : null
}

/** Parses inline spans: code, strong, emphasis, strike-through, links and breaks. */
export function parseInline(input: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let text = ''
  let i = 0

  const flush = () => {
    if (text) {
      nodes.push({ type: 'text', value: text })
      text = ''
    }
  }

  while (i < input.length) {
    const rest = input.slice(i)
    const char = input[i]

    if (char === '\\' && i + 1 < input.length) {
      text += input[i + 1]
      i += 2
      continue
    }

    if (char === '\n') {
      flush()
      nodes.push({ type: 'break' })
      i += 1
      continue
    }

    if (char === '`') {
      const run = rest.match(/^`+/)?.[0] ?? '`'
      const close = input.indexOf(run, i + run.length)
      if (close > -1) {
        flush()
        nodes.push({ type: 'code', value: input.slice(i + run.length, close) })
        i = close + run.length
        continue
      }
    }

    if (rest.startsWith('**') || rest.startsWith('__')) {
      const marker = rest.slice(0, 2)
      const close = input.indexOf(marker, i + 2)
      if (close > i + 2) {
        flush()
        nodes.push({ type: 'strong', children: parseInline(input.slice(i + 2, close)) })
        i = close + 2
        continue
      }
    }

    if (rest.startsWith('~~')) {
      const close = input.indexOf('~~', i + 2)
      if (close > i + 2) {
        flush()
        nodes.push({ type: 'del', children: parseInline(input.slice(i + 2, close)) })
        i = close + 2
        continue
      }
    }

    if (char === '[') {
      const close = input.indexOf('](', i + 1)
      const end = close > -1 ? input.indexOf(')', close + 2) : -1
      if (close > -1 && end > -1) {
        const href = safeHref(input.slice(close + 2, end))
        if (href) {
          flush()
          nodes.push({
            type: 'link',
            href,
            children: parseInline(input.slice(i + 1, close)),
          })
          i = end + 1
          continue
        }
      }
    }

    if (char === '*' || char === '_') {
      // `_` inside a word (snake_case, file_names) must not start emphasis.
      const insideWord = char === '_' && /\w/.test(input[i - 1] ?? ' ')
      const close = insideWord ? -1 : input.indexOf(char, i + 1)
      const usable = close > i + 1 && input[close + 1] !== char && !/\s/.test(input[i + 1] ?? ' ')
      if (usable) {
        flush()
        nodes.push({ type: 'em', children: parseInline(input.slice(i + 1, close)) })
        i = close + 1
        continue
      }
    }

    if ((char === 'h' || char === 'H') && (i === 0 || /[\s(]/.test(input[i - 1] ?? ' '))) {
      const url = rest.match(BARE_URL)?.[0]
      if (url) {
        flush()
        nodes.push({ type: 'link', href: url, children: [{ type: 'text', value: url }] })
        i += url.length
        continue
      }
    }

    text += char
    i += 1
  }

  flush()
  return nodes
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  let inCode = false
  for (const char of trimmed) {
    if (char === '`') inCode = !inCode
    if (char === '|' && !inCode) {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}

function parseBlocks(lines: string[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (!line.trim()) {
      i += 1
      continue
    }

    const fence = line.match(FENCE)
    if (fence) {
      const [, , marker = '```', lang = ''] = fence
      const close = lines.findIndex(
        (candidate, index) => index > i && candidate.trim().startsWith(marker.slice(0, 3)),
      )
      const end = close === -1 ? lines.length : close
      blocks.push({
        type: 'code',
        lang: lang || null,
        value: lines.slice(i + 1, end).join('\n'),
      })
      i = close === -1 ? lines.length : close + 1
      continue
    }

    const heading = line.match(HEADING)
    if (heading) {
      const hashes = heading[1] ?? '#'
      blocks.push({
        type: 'heading',
        level: hashes.length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline((heading[2] ?? '').trim()),
      })
      i += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      i += 1
      continue
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (
        i < lines.length &&
        (QUOTE.test(lines[i] ?? '') || (quoted.length > 0 && !(lines[i] ?? '').trim()))
      ) {
        const current = lines[i] ?? ''
        if (!current.trim()) {
          i += 1
          if (i >= lines.length || !QUOTE.test(lines[i] ?? '')) break
          quoted.push('')
          continue
        }
        quoted.push((current.match(QUOTE) as RegExpMatchArray)[1] ?? '')
        i += 1
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(quoted) })
      continue
    }

    if (isTableStart(lines, i)) {
      const head = splitRow(line).map((cell) => parseInline(cell))
      i += 2 // header + divider
      const rows: InlineNode[][][] = []
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) {
        rows.push(splitRow(lines[i] ?? '').map((cell) => parseInline(cell)))
        i += 1
      }
      blocks.push({ type: 'table', head, rows })
      continue
    }

    if (LIST_ITEM.test(line)) {
      const [list, next] = parseList(lines, i)
      blocks.push(list)
      i = next
      continue
    }

    const paragraph: string[] = []
    while (i < lines.length && (lines[i] ?? '').trim()) {
      const current = lines[i] ?? ''
      if (
        FENCE.test(current) ||
        HEADING.test(current) ||
        RULE.test(current) ||
        LIST_ITEM.test(current) ||
        QUOTE.test(current)
      ) {
        break
      }
      paragraph.push(current.trim())
      i += 1
    }
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) })
  }

  return blocks
}

function parseList(lines: string[], start: number): [MarkdownBlock, number] {
  const first = (lines[start] ?? '').match(LIST_ITEM) as RegExpMatchArray
  const baseIndent = indentOf(first[1] ?? '')
  const marker = first[2] ?? '-'
  const ordered = /\d/.test(marker)
  const startAt = ordered ? Number.parseInt(marker, 10) : 1
  const items: MarkdownListItem[] = []
  let i = start

  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.trim()) {
      const next = lines[i + 1]
      if (next && LIST_ITEM.test(next) && indentOf(next) > baseIndent) {
        i += 1
        continue
      }
      break
    }

    const item = line.match(LIST_ITEM)
    if (item && indentOf(item[1] ?? '') === baseIndent && /\d/.test(item[2] ?? '') === ordered) {
      items.push({ children: parseInline((item[3] ?? '').trim()), nested: [] })
      i += 1
      continue
    }

    if (!item && indentOf(line) > baseIndent) {
      // Continuation of the previous item: keep the line break, like the source did.
      const last = items[items.length - 1]
      if (last) {
        const extra = parseInline(line.trim())
        last.children = [...last.children, { type: 'break' }, ...extra]
      }
      i += 1
      continue
    }

    if (item && indentOf(item[1] ?? '') > baseIndent) {
      const [nested, next] = parseList(lines, i)
      const last = items[items.length - 1]
      if (last) last.nested.push(nested)
      i = next
      continue
    }

    break
  }

  return [{ type: 'list', ordered, start: startAt, items }, i]
}

export function parseMarkdown(input: string): MarkdownBlock[] {
  const normalized = input.replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
  return parseBlocks(normalized.split('\n'))
}

function inlineNodes(nodes: InlineNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`
    switch (node.type) {
      case 'code':
        return <code key={key}>{node.value}</code>
      case 'strong':
        return <strong key={key}>{inlineNodes(node.children, key)}</strong>
      case 'em':
        return <em key={key}>{inlineNodes(node.children, key)}</em>
      case 'del':
        return <del key={key}>{inlineNodes(node.children, key)}</del>
      case 'link':
        return (
          <a key={key} href={node.href} target="_blank" rel="noreferrer">
            {inlineNodes(node.children, key)}
          </a>
        )
      case 'break':
        return <br key={key} />
      default:
        return node.value
    }
  })
}

/** Headings inside a panel step down one level so they never outrank the page title. */
const HEADING_TAG = { 1: 'h3', 2: 'h4', 3: 'h5', 4: 'h6', 5: 'h6', 6: 'h6' } as const

function renderBlocks(blocks: MarkdownBlock[], keyPrefix = 'b'): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}-${index}`
    switch (block.type) {
      case 'heading': {
        const Tag = HEADING_TAG[block.level]
        return <Tag key={key}>{inlineNodes(block.children, key)}</Tag>
      }
      case 'paragraph':
        return <p key={key}>{inlineNodes(block.children, key)}</p>
      case 'code':
        return (
          <pre key={key} className={block.lang ? `language-${block.lang}` : undefined}>
            <code>{block.value}</code>
          </pre>
        )
      case 'list': {
        const Tag = block.ordered ? 'ol' : 'ul'
        return (
          <Tag key={key} start={block.ordered && block.start !== 1 ? block.start : undefined}>
            {block.items.map((item, itemIndex) => {
              const itemKey = `${key}-${itemIndex}`
              return (
                <li key={itemKey}>
                  {inlineNodes(item.children, itemKey)}
                  {item.nested.length > 0 ? renderBlocks(item.nested, `${itemKey}-n`) : null}
                </li>
              )
            })}
          </Tag>
        )
      }
      case 'quote':
        return <blockquote key={key}>{renderBlocks(block.blocks, key)}</blockquote>
      case 'table':
        return (
          <div key={key} className="markdown-table">
            <table>
              <thead>
                <tr>
                  {block.head.map((cell, cellIndex) => {
                    const cellKey = `${key}-h-${cellIndex}`
                    return <th key={cellKey}>{inlineNodes(cell, cellKey)}</th>
                  })}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => {
                  const rowKey = `${key}-r-${rowIndex}`
                  return (
                    <tr key={rowKey}>
                      {row.map((cell, cellIndex) => {
                        const cellKey = `${rowKey}-${cellIndex}`
                        return <td key={cellKey}>{inlineNodes(cell, cellKey)}</td>
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      case 'rule':
        return <hr key={key} />
      default:
        return null
    }
  })
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <div className={className ? `markdown ${className}` : 'markdown'}>{renderBlocks(blocks)}</div>
  )
}
