import React, { useState } from "react";
import { Copy, Check } from "lucide-react";

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];

  let inCodeBlock = false;
  let codeLanguage = "";
  let codeLines: string[] = [];

  let inList = false;
  let listItems: string[] = [];

  let inBlockquote = false;
  let blockquoteLines: string[] = [];

  let inTable = false;
  let tableHeaders: string[] = [];
  let tableRows: string[][] = [];

  // Helper to parse inline styles: bold, italic, inline code, links
  const renderInlineText = (text: string): React.ReactNode[] => {
    const parts: React.ReactNode[] = [];
    let currentText = text;
    let keyIndex = 0;

    while (currentText.length > 0) {
      // 1. Check for Link: [label](href)
      const linkMatch = currentText.match(/\[([^\]]+)\]\(([^)]+)\)/);
      // 2. Check for Code: `code`
      const codeMatch = currentText.match(/`([^`]+)`/);
      // 3. Check for Bold: **bold**
      const boldMatch = currentText.match(/\*\*([^*]+)\*\*/);
      // 4. Check for Italic: *italic*
      const italicMatch = currentText.match(/\*([^*]+)\*/);

      // Find which match occurs first
      const matches = [
        { type: "link", match: linkMatch, index: linkMatch?.index ?? -1 },
        { type: "code", match: codeMatch, index: codeMatch?.index ?? -1 },
        { type: "bold", match: boldMatch, index: boldMatch?.index ?? -1 },
        { type: "italic", match: italicMatch, index: italicMatch?.index ?? -1 },
      ].filter((m) => m.index !== -1);

      if (matches.length === 0) {
        parts.push(<span key={`text-${keyIndex++}`}>{currentText}</span>);
        break;
      }

      // Sort by earliest match
      matches.sort((a, b) => a.index - b.index);
      const earliest = matches[0]!;

      // Add leading plain text
      if (earliest.index > 0) {
        parts.push(
          <span key={`text-${keyIndex++}`}>
            {currentText.substring(0, earliest.index)}
          </span>
        );
      }

      if (earliest.type === "link" && earliest.match) {
        const [full, label, href] = earliest.match;
        parts.push(
          <a
            key={`link-${keyIndex++}`}
            href={href}
            target={href.startsWith("http") ? "_blank" : undefined}
            rel="noopener noreferrer"
            className="text-brand-400 hover:text-brand-accent hover:underline font-medium transition-colors"
          >
            {label}
          </a>
        );
        currentText = currentText.substring(earliest.index + full.length);
      } else if (earliest.type === "code" && earliest.match) {
        const [full, code] = earliest.match;
        parts.push(
          <code
            key={`inline-code-${keyIndex++}`}
            className="px-1.5 py-0.5 rounded bg-bg-hover border border-sidebar-border text-pink-400 font-mono text-xs"
          >
            {code}
          </code>
        );
        currentText = currentText.substring(earliest.index + full.length);
      } else if (earliest.type === "bold" && earliest.match) {
        const [full, bold] = earliest.match;
        parts.push(
          <strong key={`bold-${keyIndex++}`} className="font-bold text-title-text">
            {bold}
          </strong>
        );
        currentText = currentText.substring(earliest.index + full.length);
      } else if (earliest.type === "italic" && earliest.match) {
        const [full, italic] = earliest.match;
        parts.push(
          <em key={`italic-${keyIndex++}`} className="italic">
            {italic}
          </em>
        );
        currentText = currentText.substring(earliest.index + full.length);
      }
    }

    return parts;
  };

  const flushList = (key: number) => {
    if (listItems.length > 0) {
      elements.push(
        <ul key={`list-${key}`} className="list-disc pl-6 my-4 space-y-2 text-main-text">
          {listItems.map((item, idx) => (
            <li key={idx} className="leading-relaxed">
              {renderInlineText(item)}
            </li>
          ))}
        </ul>
      );
      listItems = [];
      inList = false;
    }
  };

  const flushBlockquote = (key: number) => {
    if (blockquoteLines.length > 0) {
      // Check for Github-style alerts: [!NOTE], [!IMPORTANT], [!WARNING], [!TIP]
      const firstLine = blockquoteLines[0] || "";
      let alertType: "note" | "important" | "warning" | "tip" | null = null;
      let alertContentLines = [...blockquoteLines];

      if (firstLine.startsWith("[!NOTE]")) {
        alertType = "note";
        alertContentLines[0] = firstLine.replace("[!NOTE]", "").trim();
      } else if (firstLine.startsWith("[!IMPORTANT]")) {
        alertType = "important";
        alertContentLines[0] = firstLine.replace("[!IMPORTANT]", "").trim();
      } else if (firstLine.startsWith("[!WARNING]")) {
        alertType = "warning";
        alertContentLines[0] = firstLine.replace("[!WARNING]", "").trim();
      } else if (firstLine.startsWith("[!TIP]")) {
        alertType = "tip";
        alertContentLines[0] = firstLine.replace("[!TIP]", "").trim();
      }

      // Filter empty lines out of content
      const contentText = alertContentLines.join("\n").trim();

      if (alertType) {
        const styles = {
          note: {
            border: "border-l-4 border-blue-500",
            bg: "bg-blue-500/5",
            text: "text-blue-400",
            title: "Note",
          },
          important: {
            border: "border-l-4 border-brand-500",
            bg: "bg-brand-500/5",
            text: "text-brand-400",
            title: "Important",
          },
          warning: {
            border: "border-l-4 border-yellow-500",
            bg: "bg-yellow-500/5",
            text: "text-yellow-400",
            title: "Warning",
          },
          tip: {
            border: "border-l-4 border-green-500",
            bg: "bg-green-500/5",
            text: "text-green-400",
            title: "Tip",
          },
        }[alertType];

        elements.push(
          <div
            key={`alert-${key}`}
            className={`p-4 my-6 rounded-r-xl ${styles.border} ${styles.bg} transition-all`}
          >
            <div className={`font-semibold text-sm mb-1 ${styles.text}`}>
              {styles.title}
            </div>
            <div className="text-sm leading-relaxed text-main-text">
              {renderInlineText(contentText)}
            </div>
          </div>
        );
      } else {
        elements.push(
          <blockquote
            key={`quote-${key}`}
            className="pl-4 my-6 border-l-4 border-sidebar-border italic text-muted-text bg-bg-hover/30 py-2 rounded-r"
          >
            {blockquoteLines.map((line, idx) => (
              <p key={idx} className="leading-relaxed">
                {renderInlineText(line)}
              </p>
            ))}
          </blockquote>
        );
      }

      blockquoteLines = [];
      inBlockquote = false;
    }
  };

  const flushTable = (key: number) => {
    if (tableHeaders.length > 0 || tableRows.length > 0) {
      elements.push(
        <div key={`table-wrapper-${key}`} className="overflow-x-auto my-6 rounded-xl border border-sidebar-border shadow-md">
          <table className="w-full border-collapse text-left text-sm text-main-text">
            {tableHeaders.length > 0 && (
              <thead className="bg-sidebar-bg border-b border-sidebar-border text-title-text font-semibold">
                <tr>
                  {tableHeaders.map((hdr, idx) => (
                    <th key={idx} className="px-4 py-3">
                      {renderInlineText(hdr)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody className="divide-y divide-sidebar-border">
              {tableRows.map((row, rowIdx) => (
                <tr key={rowIdx} className="hover:bg-bg-hover/20 transition-colors">
                  {row.map((cell, cellIdx) => (
                    <td key={cellIdx} className="px-4 py-3">
                      {renderInlineText(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      tableHeaders = [];
      tableRows = [];
      inTable = false;
    }
  };

  // Main line-by-line parser loop
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();

    // 1. Code block handling
    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        // End code block
        const codeText = codeLines.join("\n");
        elements.push(
          <CodeBlockContainer
            key={`code-${i}`}
            code={codeText}
            language={codeLanguage}
          />
        );
        codeLines = [];
        inCodeBlock = false;
      } else {
        // Start code block
        flushList(i);
        flushBlockquote(i);
        flushTable(i);
        inCodeBlock = true;
        codeLanguage = trimmed.replace("```", "").trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    // 2. Table handling (starting with | )
    if (trimmed.startsWith("|")) {
      flushList(i);
      flushBlockquote(i);
      inTable = true;
      const cells = trimmed
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());

      // If it is the separator line (e.g. |---|:---|), skip it
      if (cells.every((cell) => cell.match(/^:?-+:?$/))) {
        continue;
      }

      if (tableHeaders.length === 0) {
        tableHeaders = cells;
      } else {
        tableRows.push(cells);
      }
      continue;
    } else if (inTable) {
      flushTable(i);
    }

    // 3. Blockquote / Alert handling
    if (trimmed.startsWith(">")) {
      flushList(i);
      inBlockquote = true;
      const content = rawLine.substring(rawLine.indexOf(">") + 1).trim();
      blockquoteLines.push(content);
      continue;
    } else if (inBlockquote) {
      flushBlockquote(i);
    }

    // 4. List handling
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      inList = true;
      listItems.push(trimmed.substring(2));
      continue;
    } else if (inList) {
      flushList(i);
    }

    // 5. Headings
    if (trimmed.startsWith("# ")) {
      elements.push(
        <h1
          key={`h1-${i}`}
          className="text-3xl font-bold mt-8 mb-4 border-b border-sidebar-border pb-2 text-title-text"
        >
          {renderInlineText(trimmed.substring(2))}
        </h1>
      );
      continue;
    }
    if (trimmed.startsWith("## ")) {
      elements.push(
        <h2 key={`h2-${i}`} className="text-2xl font-bold mt-8 mb-4 text-title-text">
          {renderInlineText(trimmed.substring(3))}
        </h2>
      );
      continue;
    }
    if (trimmed.startsWith("### ")) {
      elements.push(
        <h3 key={`h3-${i}`} className="text-xl font-bold mt-6 mb-3 text-title-text">
          {renderInlineText(trimmed.substring(4))}
        </h3>
      );
      continue;
    }
    if (trimmed.startsWith("#### ")) {
      elements.push(
        <h4 key={`h4-${i}`} className="text-lg font-bold mt-6 mb-2 text-title-text">
          {renderInlineText(trimmed.substring(5))}
        </h4>
      );
      continue;
    }

    // 6. Horizontal Rule
    if (trimmed === "---" || trimmed === "***") {
      elements.push(
        <hr key={`hr-${i}`} className="my-8 border-sidebar-border" />
      );
      continue;
    }

    // 7. Paragraph or empty line
    if (trimmed === "") {
      continue;
    }

    elements.push(
      <p key={`p-${i}`} className="my-4 leading-relaxed text-main-text text-base">
        {renderInlineText(trimmed)}
      </p>
    );
  }

  // Flush remaining buffers
  flushList(lines.length);
  flushBlockquote(lines.length);
  flushTable(lines.length);

  return <div className="markdown-body space-y-1">{elements}</div>;
}

// Subcomponent for Code Block rendering with copy button
function CodeBlockContainer({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div className="my-6 rounded-xl border border-sidebar-border overflow-hidden bg-sidebar-bg shadow-md">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-sidebar-border bg-sidebar-bg/60">
        <span className="text-xs font-mono text-muted-text select-none">
          {language || "code"}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted-text hover:text-title-text rounded hover:bg-bg-hover transition-colors font-medium cursor-pointer"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-green-400" />
              <span className="text-green-400">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Code body */}
      <pre className="p-4 overflow-x-auto font-mono text-sm leading-relaxed text-emerald-400 bg-main-bg">
        <code>{code}</code>
      </pre>
    </div>
  );
}
