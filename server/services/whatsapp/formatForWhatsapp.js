/**
 * Safety net for WhatsApp replies. The system prompt already asks Lume to
 * write WhatsApp-native (see channel='whatsapp' in advisorAgent.js), but
 * LLMs don't always follow formatting instructions consistently — this
 * strips any web-style markdown that slips through so the user never sees
 * raw heading/bold/rule characters WhatsApp doesn't render.
 */
function formatForWhatsapp(text) {
  if (!text) return text;

  return text
    // **bold** -> *bold* (WhatsApp's own bold syntax)
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    // markdown headers: strip the leading #'s, keep the text
    .replace(/^#{1,6}\s+/gm, '')
    // markdown table separator rows, e.g. "|---|---|" or ":--|--:" — drop entirely.
    // Trailing/leading whitespace here is deliberately [ \t]*, not \s* — \s
    // includes \n, and a greedy \s*$ would swallow the newline into the
    // match, gluing this line's (deleted) content onto the next line.
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/gm, '')
    // remaining table rows "| a | b |" -> "a - b" (still readable as plain text)
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, row) => row.split('|').map((c) => c.trim()).filter(Boolean).join(' - '))
    // horizontal rules
    .replace(/^[ \t]*-{3,}[ \t]*$/gm, '')
    // markdown bullets "- " / "* " at line start -> plain "- "
    .replace(/^[ \t]*[*•][ \t]+/gm, '- ')
    // collapse 3+ blank lines down to 1
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { formatForWhatsapp };
