import { useState, useRef, useEffect, Fragment, useCallback, cloneElement } from 'react';
import { apiFetch } from '../../lib/apiClient.js';
import { useAuth } from '../../context/AuthContext.jsx';

// Locally cached transcript so reopening the Advisor paints instantly
// instead of showing an empty panel until the round trip finishes; the
// fetch still runs and reconciles in the background.
//
// The key is namespaced by organization on purpose — a shared browser must
// never flash one pharmacy's conversation to whoever signs in next.
const CACHE_VERSION = 'v1';
const cacheKey = (organizationId) => `rxnaija.advisor.${CACHE_VERSION}.${organizationId || 'anon'}`;

function readCache(organizationId) {
  if (!organizationId) return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(organizationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch (_) {
    return null; // corrupt or unavailable storage is never fatal here
  }
}

function writeCache(organizationId, conversationId, messages) {
  if (!organizationId) return;
  try {
    window.localStorage.setItem(
      cacheKey(organizationId),
      JSON.stringify({ conversationId, messages, savedAt: Date.now() })
    );
  } catch (_) {
    // Quota exceeded or storage disabled — the server copy is authoritative.
  }
}

const STARTER_QUESTIONS = [
  'How much did I sell?',
  'Is the business growing?',
  'Which products make the most profit?',
  'Why did sales change?',
  "What's my biggest risk right now?",
];

// The advisor's LLM naturally writes markdown (bold, italics, inline code,
// headers, tables, lists, dividers). This is a small dependency-free
// renderer for just the subset it actually produces — not a general
// markdown parser.
function renderInline(text, keyPrefix) {
  const parts = text.split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${keyPrefix}-${i}`} className="font-semibold text-[var(--color-ink)]">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={`${keyPrefix}-${i}`} className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg-alt)] px-1.5 py-[1px] font-mono text-[0.84em] text-[var(--color-primary)]">
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = link[2];
      // Only http(s) — a model-authored javascript:/data: URL must never
      // become a clickable target inside the dashboard.
      if (/^https?:\/\//i.test(href)) {
        return (
          <a
            key={`${keyPrefix}-${i}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[var(--color-primary)] underline decoration-[var(--color-primary)]/30 underline-offset-2 transition-colors hover:decoration-[var(--color-primary)]"
          >
            {link[1]}
          </a>
        );
      }
      return <Fragment key={`${keyPrefix}-${i}`}>{link[1]}</Fragment>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 1) {
      return <em key={`${keyPrefix}-${i}`} className="italic">{part.slice(1, -1)}</em>;
    }
    return <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>;
  });
}

// A cell is numeric if what's left after stripping currency, separators and
// a trailing unit is a number. Those columns get right-aligned and set in
// tabular figures so digits line up down the column the way a finance table
// should — the single biggest readability win in an analytics answer.
const NUMERIC_CELL = /^[-+(]?\s*[₦$€£¥]?\s*[\d,]+(\.\d+)?\s*%?\s*\)?$/;
const isNumericCell = (s) => NUMERIC_CELL.test(String(s).trim());

// `caret` is the streaming cursor. It has to be threaded in here rather than
// rendered after the call: every block this returns is block-level, so a
// caret appended as a sibling lands on its own line under the text instead
// of trailing the last word.
function renderMarkdownLite(text, caret = null) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;

  // In markdown a paragraph runs until a blank line, but the model hard-wraps
  // its prose, so rendering one <p> per source line chopped every answer into
  // ragged fragments ("…up 8.4% on" / "the previous 90 days…") each carrying
  // its own margin. Lines are joined until something that actually starts a
  // new block turns up.
  const startsBlock = (l) =>
    l == null ||
    l.trim() === '' ||
    /^\s*(-{3,}|—{3,}|_{3,})\s*$/.test(l) ||
    /^\s*```/.test(l) ||
    /^\s*>\s?/.test(l) ||
    /^\s*\|.*\|\s*$/.test(l) ||
    /^\s*[-•*]\s+/.test(l) ||
    /^\s*\d+\.\s+/.test(l) ||
    /^#{1,4}\s+/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*(-{3,}|—{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={blocks.length} className="my-4 border-t border-[var(--color-line)]" />);
      i++;
      continue;
    }

    // Fenced code block. Previously unhandled, so the fences and everything
    // between them rendered as literal paragraph text.
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      i++;
      const code = [];
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // closing fence
      blocks.push(
        <pre key={blocks.length} className="my-3 overflow-x-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-bg-alt)] px-3.5 py-3">
          <code className="font-mono text-[12px] leading-relaxed text-[var(--color-ink)]">{code.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Blockquote — the Advisor uses these for caveats and data-coverage
    // warnings, which deserve to stand apart from the body copy.
    if (/^\s*>\s?/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      // Same wrapping problem as body copy — join until a blank quoted line.
      const quotedParas = [];
      let run = [];
      for (const q of quoted) {
        if (q.trim() === '') {
          if (run.length) { quotedParas.push(run.join(' ')); run = []; }
        } else {
          run.push(q.trim());
        }
      }
      if (run.length) quotedParas.push(run.join(' '));
      blocks.push(
        <div key={blocks.length} className="my-3 rounded-r-lg border-l-2 border-[var(--color-primary)]/40 bg-[var(--color-primary-tint)]/50 py-2 pl-3.5 pr-3">
          {quotedParas.map((q, j) => (
            <p key={j} className="text-[12.5px] leading-relaxed text-[var(--color-ink-soft)] [&+p]:mt-2">{renderInline(q, `bq${j}`)}</p>
          ))}
        </div>
      );
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const tableLines = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      const rows = tableLines
        .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
        .filter((cells) => !cells.every((c) => /^:?-+:?$/.test(c)));
      const [header, ...body] = rows;
      // Decide alignment per column from the body, not the header, so a
      // "Revenue" label doesn't force its numbers left.
      const numericCols = (header || []).map((_, j) =>
        body.length > 0 && body.every((r) => r[j] == null || r[j] === '' || isNumericCell(r[j]))
      );
      blocks.push(
        <div key={blocks.length} className="my-3 overflow-x-auto rounded-xl border border-[var(--color-line)]">
          <table className="w-full border-collapse text-[12px]">
            {header && (
              <thead>
                <tr>
                  {header.map((c, j) => (
                    <th
                      key={j}
                      className={`whitespace-nowrap border-b border-[var(--color-line)] bg-[var(--color-bg-alt)] px-3 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-ink-soft)] ${numericCols[j] ? 'text-right' : 'text-left'}`}
                    >
                      {renderInline(c, `h${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((row, r) => (
                <tr key={r} className="transition-colors hover:bg-[var(--color-bg-alt)]/50">
                  {row.map((c, j) => (
                    <td
                      key={j}
                      className={`border-b border-[var(--color-line)]/60 px-3 py-2 text-[var(--color-ink)] ${numericCols[j] ? 'text-right tabular-nums' : 'text-left'}`}
                    >
                      {renderInline(c, `r${r}c${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (/^\s*[-•*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-•*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-•*]\s+/, '').trim());
        i++;
        // Wrapped remainder of the same bullet.
        while (i < lines.length && !startsBlock(lines[i])) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i++;
        }
      }
      blocks.push(
        <ul key={blocks.length} className="my-2.5 space-y-1.5">
          {items.map((it, j) => (
            <li key={j} className="flex gap-2.5">
              <span className="mt-[8px] h-[3px] w-[3px] shrink-0 rounded-full bg-[var(--color-primary)]/60" />
              <span className="min-w-0 flex-1">{renderInline(it, `ul${j}`)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, '').trim());
        i++;
        // Wrapped remainder of the same numbered item.
        while (i < lines.length && !startsBlock(lines[i])) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i++;
        }
      }
      blocks.push(
        <ol key={blocks.length} className="my-2.5 space-y-2">
          {items.map((it, j) => (
            <li key={j} className="flex gap-2.5">
              <span className="mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md bg-[var(--color-primary-tint)] text-[10px] font-bold tabular-nums text-[var(--color-primary)]">
                {j + 1}
              </span>
              <span className="min-w-0 flex-1">{renderInline(it, `ol${j}`)}</span>
            </li>
          ))}
        </ol>
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      const level = heading[1].length;
      // Top levels read as section titles; deeper ones as micro-labels, so
      // a long answer has a visible hierarchy instead of uniform bold text.
      const cls = level <= 2
        ? 'text-[14px] font-bold tracking-tight text-[var(--color-ink)]'
        : 'text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-ink-soft)]';
      blocks.push(
        <p key={blocks.length} className={`${cls} mt-4 mb-2 first:mt-0`}>
          {renderInline(heading[2], `hd${blocks.length}`)}
        </p>
      );
      i++;
      continue;
    }

    if (line.trim() === '') { i++; continue; }

    const para = [line.trim()];
    i++;
    while (i < lines.length && !startsBlock(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push(
      <p key={blocks.length} className="my-2 first:mt-0 last:mb-0">
        {renderInline(para.join(' '), `p${blocks.length}`)}
      </p>
    );
  }

  if (caret) {
    const last = blocks[blocks.length - 1];
    // Tuck it inside the trailing paragraph when there is one; mid-table or
    // mid-list there's no sensible inline home, so it stands alone.
    if (last && last.type === 'p') {
      const kids = Array.isArray(last.props.children) ? last.props.children : [last.props.children];
      blocks[blocks.length - 1] = cloneElement(last, undefined, [...kids, caret]);
    } else {
      blocks.push(<p key="caret-line">{caret}</p>);
    }
  }

  return blocks;
}

function AdvisorAvatar() {
  return (
    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    </div>
  );
}

function Bubble({ role, content, streaming = false }) {
  const isUser = role === 'user';
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-[var(--color-primary)] px-4 py-2.5 text-[13.5px] leading-relaxed text-primary-foreground shadow-sm">
          {content}
        </div>
      </div>
    );
  }
  // The assistant's answer is not chat chatter — it's a report containing
  // tables, figures and headings. Boxing it in a bubble capped it at 80% of
  // an already narrow column and forced tables to scroll inside a card
  // inside a panel. Setting it directly on the surface gives that content
  // the full width and lets the type hierarchy do the separating instead.
  return (
    <div className="flex justify-start gap-2.5">
      <AdvisorAvatar />
      <div className="min-w-0 flex-1 pt-0.5 text-[13.5px] leading-[1.65] text-[var(--color-ink)]">
        {renderMarkdownLite(
          content,
          streaming ? (
            <span
              key="caret"
              className="advisor-caret ml-1 inline-block h-[14px] w-[2.5px] translate-y-[2px] rounded-full bg-[var(--color-primary)]"
            />
          ) : null
        )}
      </div>
    </div>
  );
}

// Shown between sending a question and the first streamed token.
function ThinkingIndicator() {
  return (
    <div className="flex justify-start gap-2.5" role="status" aria-live="polite">
      <AdvisorAvatar />
      <div className="flex items-center gap-2 pt-1">
        <span className="advisor-orb h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="advisor-thinking-label text-[12.5px] font-medium">
          Analysing your data
        </span>
      </div>
    </div>
  );
}

// Shown only when there's nothing cached to paint — a shaped placeholder
// reads as "content is coming" where a blank panel reads as "broken".
function ChatSkeleton() {
  const rows = [
    { side: 'right', w: '42%' },
    { side: 'left', w: '78%' },
    { side: 'left', w: '55%' },
    { side: 'right', w: '35%' },
    { side: 'left', w: '68%' },
  ];
  return (
    <div className="space-y-5" aria-hidden="true">
      {rows.map((r, i) => (
        <div key={i} className={`flex ${r.side === 'right' ? 'justify-end' : 'justify-start'}`}>
          <div
            className="advisor-shimmer rounded-2xl"
            style={{ width: r.w, height: r.side === 'left' ? 56 : 34 }}
          />
        </div>
      ))}
    </div>
  );
}

function SidebarSkeleton() {
  return (
    <div className="space-y-2 px-2" aria-hidden="true">
      {[72, 88, 64, 80].map((w, i) => (
        <div key={i} className="advisor-shimmer h-8 rounded-lg" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

// Conversations accumulate without limit, and rendering all of them buries
// the handful the owner actually returns to under months of history.
const INITIAL_CONVERSATIONS = 7;
const CONVERSATION_BATCH = 10;

/**
 * Sidebar conversation list, revealed progressively.
 *
 * Starts at the most recent few behind an explicit "Show more". Once the
 * owner has opened it once, further batches load on their own as the end of
 * the list comes into view — the infinite-scroll behaviour only earns its
 * place after they've signalled they want more history.
 *
 * The observer is deliberately NOT armed for the first batch: seven rows
 * don't fill the sidebar, so its sentinel would already be on screen and
 * would immediately reveal everything, which is the behaviour this replaces.
 *
 * Rendered twice (inline sidebar and mobile slide-over), so it owns its own
 * observer per instance rather than sharing one ref across both.
 */
function ConversationList({
  conversations, conversationsLoaded, conversationId, loading,
  visibleCount, onShowMore, onSelect, onNewChat,
}) {
  const sentinelRef = useRef(null);
  const visible = conversations.slice(0, visibleCount);
  const hiddenCount = conversations.length - visible.length;
  const hasMore = hiddenCount > 0;
  const autoLoad = hasMore && visibleCount > INITIAL_CONVERSATIONS;

  useEffect(() => {
    if (!autoLoad) return undefined;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    // Default root is the viewport, but intersection still accounts for
    // clipping by the sidebar's own overflow container — so this fires when
    // the row reaches the bottom of the list, not merely when the sidebar
    // is on screen.
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) onShowMore(); },
      { rootMargin: '60px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [autoLoad, onShowMore, visibleCount]);

  return (
    <>
      <button
        type="button"
        onClick={onNewChat}
        disabled={loading}
        className="mb-3 flex w-full items-center gap-2 rounded-lg border border-[var(--color-line)] px-3 py-2 text-xs font-medium text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] disabled:opacity-50"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        New chat
      </button>

      <p className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">Recent</p>

      {!conversationsLoaded ? (
        <SidebarSkeleton />
      ) : conversations.length === 0 ? (
        <p className="px-2 text-[11px] text-[var(--color-ink-faint)]">No conversations yet.</p>
      ) : (
        <>
          <ul className="space-y-0.5">
            {visible.map((c) => {
              const isCurrent = c.id === conversationId;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    disabled={loading}
                    aria-current={isCurrent ? 'true' : undefined}
                    title={c.title}
                    className={`w-full truncate rounded-lg px-2.5 py-2 text-left text-xs transition-colors disabled:opacity-50 ${
                      isCurrent
                        ? 'bg-[var(--color-primary-tint)] font-medium text-[var(--color-primary)]'
                        : 'text-[var(--color-ink-soft)] hover:bg-[var(--color-bg-alt)]'
                    }`}
                  >
                    {c.title}
                  </button>
                </li>
              );
            })}
          </ul>

          {hasMore && (
            <>
              {/* Watched once auto-loading is armed; harmless before that. */}
              <div ref={sentinelRef} aria-hidden="true" className="h-px" />
              <button
                type="button"
                onClick={onShowMore}
                className="mt-1 w-full rounded-lg px-2.5 py-2 text-left text-[11px] font-medium text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-bg-alt)] hover:text-[var(--color-primary)]"
              >
                {`Show ${Math.min(hiddenCount, CONVERSATION_BATCH)} more`}
                {hiddenCount > CONVERSATION_BATCH ? ` of ${hiddenCount}` : ''}
              </button>
            </>
          )}
        </>
      )}
    </>
  );
}

export default function AdvisorChat({ analysisContext = null }) {
  const { organization } = useAuth();
  const organizationId = organization?.organizationId || null;

  // Seed straight from cache during the very first render so returning to
  // the Advisor paints the previous conversation immediately rather than
  // after a round trip.
  const [messages, setMessages] = useState(() => readCache(organizationId)?.messages || []);
  const [conversationId, setConversationId] = useState(() => readCache(organizationId)?.conversationId || null);
  // Only a cold start (nothing cached) should show skeletons.
  const [historyLoaded, setHistoryLoaded] = useState(() => !!readCache(organizationId));
  const [conversations, setConversations] = useState([]);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Held here rather than in ConversationList so the inline sidebar and the
  // mobile slide-over stay on the same page of history as the viewport
  // crosses the md breakpoint.
  const [visibleConversations, setVisibleConversations] = useState(INITIAL_CONVERSATIONS);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [error, setError] = useState('');
  const scrollRef = useRef(null);

  const refreshConversations = useCallback(async () => {
    try {
      const res = await apiFetch('/api/advisor-chat/conversations');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.conversations)) setConversations(data.conversations);
    } catch (_) {
      // Sidebar is an enhancement — its failure must not block the chat.
    } finally {
      setConversationsLoaded(true);
    }
  }, []);

  // Conversation is persisted server-side (advisor_message table) — load it
  // on mount so reloading the page or switching tabs doesn't wipe it. Any
  // cached copy is already on screen; this reconciles it with the server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/advisor-chat/history');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data.messages)) {
          setMessages(data.messages);
          setConversationId(data.conversationId || null);
          writeCache(organizationId, data.conversationId, data.messages);
        }
      } catch (_) {
        // Non-fatal — chat still works for this session, just without prior history.
      } finally {
        if (!cancelled) setHistoryLoaded(true);
      }
    })();
    refreshConversations();
    return () => { cancelled = true; };
  }, [organizationId, refreshConversations]);

  const selectConversation = async (id) => {
    if (loading || id === conversationId) { setSidebarOpen(false); return; }
    setSwitching(true);
    setError('');
    setStreamingText('');
    setSidebarOpen(false);
    try {
      const res = await apiFetch(`/api/advisor-chat/history?conversationId=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error('Could not open that conversation.');
      const data = await res.json();
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      setConversationId(data.conversationId || id);
      writeCache(organizationId, data.conversationId || id, data.messages || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setSwitching(false);
    }
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading, streamingText]);

  const send = async (text) => {
    const question = (text ?? input).trim();
    if (!question || loading) return;

    const nextMessages = [...messages, { role: 'user', content: question }];
    setMessages(nextMessages);
    setInput('');
    setError('');
    setStreamingText('');
    setLoading(true);

    try {
      const res = await apiFetch('/api/advisor-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send the on-screen conversation's id so a reply lands in the
        // thread the user is actually looking at, not whichever one the
        // server considers active.
        // analysisContext is what the dashboard is currently showing. Sending
        // it makes those figures authoritative, so the Advisor can't answer
        // with a number that contradicts what's on screen.
        body: JSON.stringify({ message: question, conversationId, analysisContext }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Advisor request failed');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assembled = '';
      let streamError = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const raw of events) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }

          if (evt.type === 'token') {
            assembled += evt.token;
            setStreamingText(assembled);
          } else if (evt.type === 'error') {
            streamError = evt.error;
          }
        }
      }

      if (streamError) throw new Error(streamError);
      const finalMessages = [...nextMessages, { role: 'assistant', content: assembled }];
      setMessages(finalMessages);
      setStreamingText('');
      writeCache(organizationId, conversationId, finalMessages);
      // The first message in a thread is what the sidebar titles it by, so
      // refresh the list once the exchange completes.
      refreshConversations();
    } catch (err) {
      setError(err.message);
      setMessages(nextMessages);
      setStreamingText('');
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    send();
  };

  const startNewChat = async () => {
    if (loading) return;
    try {
      const res = await apiFetch('/api/advisor-chat/new', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      setConversationId(data.conversationId || null);
      writeCache(organizationId, data.conversationId || null, []);
    } catch (_) {
      // Non-fatal — worst case the next message still lands in the old
      // conversation rather than blocking the user from starting fresh.
    }
    setMessages([]);
    setStreamingText('');
    setError('');
    setSidebarOpen(false);
    refreshConversations();
  };

  const showMoreConversations = useCallback(() => {
    setVisibleConversations((n) => n + CONVERSATION_BATCH);
  }, []);

  const conversationList = (
    <ConversationList
      conversations={conversations}
      conversationsLoaded={conversationsLoaded}
      conversationId={conversationId}
      loading={loading}
      visibleCount={visibleConversations}
      onShowMore={showMoreConversations}
      onSelect={selectConversation}
      onNewChat={startNewChat}
    />
  );

  return (
    <div className="relative flex overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] h-[70vh] min-h-[480px]">
      {/* Conversation history — inline from md up, slide-over on small screens */}
      <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r border-[var(--color-line)] bg-[var(--color-bg-alt)]/40 p-3 md:flex">
        {conversationList}
      </aside>

      {sidebarOpen && (
        <div className="absolute inset-0 z-20 flex md:hidden">
          <div className="absolute inset-0 bg-black/20" onClick={() => setSidebarOpen(false)} />
          <aside className="relative z-10 flex h-full w-60 flex-col overflow-y-auto border-r border-[var(--color-line)] bg-[var(--color-bg)] p-3 shadow-xl">
            {conversationList}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
      <div className="px-5 py-3 border-b border-[var(--color-line)] flex items-center gap-2">
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          aria-label="Show conversation history"
          className="-ml-1 mr-0.5 rounded-lg p-1.5 text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-primary)] md:hidden"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[var(--color-ink)]">AI Advisor</p>
          <p className="text-[11px] text-[var(--color-ink-faint)]">Ask anything about your data</p>
        </div>
        <button
          type="button"
          onClick={startNewChat}
          disabled={loading}
          className="rounded-full border border-[var(--color-line)] px-3 py-1.5 text-xs text-[var(--color-ink-soft)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-colors disabled:opacity-50 md:hidden"
        >
          New chat
        </button>
      </div>

      {/* Unboxed assistant answers need real separation between turns —
          without the bubble outline, tight spacing runs them together. */}
      <div ref={scrollRef} className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
        {/* Cold start (nothing cached) or mid-switch: shaped placeholders
            rather than an empty panel, so it reads as loading not broken. */}
        {(!historyLoaded || switching) && messages.length === 0 && <ChatSkeleton />}

        {messages.length === 0 && historyLoaded && !switching && (
          <div className="h-full flex flex-col items-center justify-center text-center gap-4">
            <p className="text-sm text-[var(--color-ink-faint)] max-w-xs">
              Ask about revenue, margins, stock, customers, or what to do next — answers are grounded in your uploaded data.
            </p>
            <div className="flex flex-wrap justify-center gap-2 max-w-md">
              {STARTER_QUESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  className="rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink-soft)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <Bubble key={i} role={m.role} content={m.content} />
        ))}

        {loading && streamingText && (
          <Bubble role="assistant" content={streamingText} streaming />
        )}

        {loading && !streamingText && <ThinkingIndicator />}

        {error && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm border border-destructive/20 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
              {error}
            </div>
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="border-t border-[var(--color-line)] p-3 flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your business..."
          className="flex-1 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2.5 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:outline-none focus:border-[var(--color-primary)]"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-primary-foreground disabled:opacity-40 transition"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </form>
      </div>
    </div>
  );
}
