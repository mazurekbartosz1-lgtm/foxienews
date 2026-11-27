import React from "react";
import { normalizeSlug } from "./firebase";

interface MarkdownContentProps {
  markdown: string;
  onNavigateSlug?: (slug: string) => void;
}

function stripFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n[\s\S]*?\n---(?:\n|$)/);
  return match ? normalized.slice(match[0].length) : normalized;
}

function renderInline(
  text: string,
  onNavigateSlug?: (slug: string) => void,
  keyPrefix = "in",
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenRe =
    /(\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|@due\(\d{4}-\d{2}-\d{2}\)|(?:^|\s)#[A-Za-z0-9_\-ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]+)/g;

  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(text.slice(lastIdx, match.index));
    }

    const token = match[0];
    const key = `${keyPrefix}-${idx++}`;

    if (token.startsWith("[[") && token.endsWith("]]")) {
      const inner = token.slice(2, -2);
      const [rawTarget, rawLabel] = inner.split("|");
      const slug = normalizeSlug(rawTarget);
      const label = (rawLabel ?? rawTarget).trim();
      nodes.push(
        <button
          key={key}
          type="button"
          onClick={() => onNavigateSlug?.(slug)}
          className="inline text-left font-medium text-[#9A4720] underline decoration-[#C66A3D]/45 underline-offset-3 transition hover:text-[#1C1A18] hover:decoration-[#1C1A18]"
        >
          {label}
        </button>,
      );
    } else if (token.startsWith("[") && token.includes("](") && token.endsWith(")")) {
      const splitIdx = token.indexOf("](");
      const label = token.slice(1, splitIdx);
      const href = token.slice(splitIdx + 2, -1).trim();
      const safeHref = /^https?:\/\//i.test(href) ? href : undefined;
      if (safeHref) {
        nodes.push(
          <a
            key={key}
            href={safeHref}
            target="_blank"
            rel="noreferrer"
            className="text-[#2F5D50] underline decoration-[#2F5D50]/40 underline-offset-3 hover:text-[#1C1A18]"
          >
            {label}
          </a>,
        );
      } else {
        nodes.push(label);
      }
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code
          key={key}
          className="font-mono-meta rounded bg-[#EFECE3] px-1.5 py-0.5 text-[0.83em] text-[#3B3630]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong key={key} className="font-semibold text-[#1C1A18]">
          {renderInline(token.slice(2, -2), onNavigateSlug, key)}
        </strong>,
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(
        <em key={key} className="italic">
          {renderInline(token.slice(1, -1), onNavigateSlug, key)}
        </em>,
      );
    } else if (/^@due\(\d{4}-\d{2}-\d{2}\)$/i.test(token)) {
      const dateStr = token.slice(5, -1);
      nodes.push(
        <span
          key={key}
          className="font-mono-meta mx-0.5 inline-block rounded border border-[#DEC9B5] bg-[#FAF0E6] px-1.5 py-0.5 text-[11px] text-[#9A4720]"
        >
          {dateStr}
        </span>,
      );
    } else {
      const leadSpace = token.startsWith(" ") ? " " : "";
      const tag = token.trim();
      nodes.push(
        <React.Fragment key={key}>
          {leadSpace}
          <span className="font-mono-meta inline-block rounded bg-[#EFECE3] px-1.5 py-0.5 text-[11px] text-[#6B655C]">
            {tag}
          </span>
        </React.Fragment>,
      );
    }

    lastIdx = match.index + token.length;
  }

  if (lastIdx < text.length) {
    nodes.push(text.slice(lastIdx));
  }

  return nodes;
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export const MarkdownContent: React.FC<MarkdownContentProps> = ({
  markdown,
  onNavigateSlug,
}) => {
  const body = stripFrontmatter(markdown);
  const lines = body.split("\n");
  const blocks: React.ReactNode[] = [];

  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    if (/^(```|~~~)/.test(trimmed)) {
      const fence = trimmed.slice(0, 3);
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <pre
          key={`b-${blockKey++}`}
          className="font-mono-meta overflow-x-auto rounded-lg border border-[#E4DFD4] bg-[#F2EFE8] p-3.5 text-xs leading-relaxed text-[#2C2824]"
        >
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(<hr key={`b-${blockKey++}`} className="my-5 border-[#E4DFD4]" />);
      i++;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = renderInline(headingMatch[2], onNavigateSlug, `h-${blockKey}`);
      if (level === 1) {
        blocks.push(
          <h1
            key={`b-${blockKey++}`}
            className="text-2xl font-medium tracking-tight text-[#1C1A18] sm:text-3xl"
          >
            {content}
          </h1>,
        );
      } else if (level === 2) {
        blocks.push(
          <h2
            key={`b-${blockKey++}`}
            className="mt-6 border-b border-[#E8E3D9] pb-1.5 text-lg font-medium text-[#1C1A18]"
          >
            {content}
          </h2>,
        );
      } else {
        blocks.push(
          <h3
            key={`b-${blockKey++}`}
            className="mt-4 text-base font-semibold text-[#2E2A26]"
          >
            {content}
          </h3>,
        );
      }
      i++;
      continue;
    }

    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableDivider(lines[i + 1])
    ) {
      const headers = parseTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      blocks.push(
        <div
          key={`b-${blockKey++}`}
          className="overflow-x-auto rounded-lg border border-[#E4DFD4] bg-white/60"
        >
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-[#F2EFE8] text-xs uppercase tracking-wider text-[#6B655C]">
              <tr>
                {headers.map((h, hIdx) => (
                  <th key={hIdx} className="border-b border-[#E4DFD4] px-3 py-2 font-medium">
                    {renderInline(h, onNavigateSlug, `th-${blockKey}-${hIdx}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EDE9DF]">
              {rows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {headers.map((_, cIdx) => (
                    <td key={cIdx} className="px-3 py-2 align-top text-[#2E2A26]">
                      {renderInline(
                        row[cIdx] ?? "",
                        onNavigateSlug,
                        `td-${blockKey}-${rIdx}-${cIdx}`,
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote
          key={`b-${blockKey++}`}
          className="border-l-2 border-[#C66A3D]/60 bg-[#F2EFE8]/70 px-4 py-2 text-sm italic text-[#4A453E]"
        >
          {renderInline(quoteLines.join(" "), onNavigateSlug, `q-${blockKey}`)}
        </blockquote>,
      );
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: Array<{ checked: boolean | null; text: string }> = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const rawItem = lines[i].trim().replace(/^[-*]\s+/, "");
        const taskMatch = rawItem.match(/^\[([ xX])\]\s+(.+)$/);
        if (taskMatch) {
          items.push({
            checked: taskMatch[1].toLowerCase() === "x",
            text: taskMatch[2],
          });
        } else {
          items.push({ checked: null, text: rawItem });
        }
        i++;
      }

      blocks.push(
        <ul key={`b-${blockKey++}`} className="space-y-1.5 pl-1">
          {items.map((item, idx) => (
            <li key={idx} className="flex items-start gap-2.5 text-[15px] leading-relaxed">
              {item.checked !== null ? (
                <span
                  aria-hidden="true"
                  className={`mt-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                    item.checked
                      ? "border-[#2F5D50] bg-[#2F5D50] text-white"
                      : "border-[#B8B1A5] bg-white"
                  }`}
                >
                  {item.checked ? "✓" : ""}
                </span>
              ) : (
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#9E978B]" />
              )}
              <span className={item.checked ? "text-[#7A756D] line-through" : "text-[#2A2622]"}>
                {renderInline(item.text, onNavigateSlug, `li-${blockKey}-${idx}`)}
              </span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={`b-${blockKey++}`} className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-[#2A2622]">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, onNavigateSlug, `ol-${blockKey}-${idx}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,4}\s+|[-*]\s+|\d+\.\s+|>\s*|```|~~~|(-{3,}|\*{3,}|_{3,})$)/.test(
        lines[i].trim(),
      )
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    blocks.push(
      <p key={`b-${blockKey++}`} className="text-[15px] leading-7 text-[#2A2622]">
        {renderInline(paraLines.join(" "), onNavigateSlug, `p-${blockKey}`)}
      </p>,
    );
  }

  return <div className="space-y-3.5">{blocks}</div>;
};
