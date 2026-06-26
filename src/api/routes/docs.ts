import express, { type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamically locate the Docs directory
const getDocsDir = (): string => {
  const rootDocs = path.resolve(process.cwd(), "Docs");
  if (fs.existsSync(rootDocs)) return rootDocs;
  return path.resolve(__dirname, "../../../Docs");
};

interface DocMetadata {
  slug: string;
  title: string;
  category: string;
  order: number;
}

interface DocContent extends DocMetadata {
  content: string;
}

const parseFrontMatter = (fileContent: string): { meta: Partial<DocMetadata>; body: string } => {
  const meta: Partial<DocMetadata> = {};
  let body = fileContent;

  const match = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (match && match[1]) {
    const yamlBlock = match[1];
    body = fileContent.substring(match[0].length);

    const lines = yamlBlock.split("\n");
    for (const line of lines) {
      const parts = line.split(":");
      if (parts.length >= 2) {
        const key = parts[0]?.trim();
        const val = parts.slice(1).join(":").trim();
        if (key === "title") meta.title = val;
        if (key === "category") meta.category = val;
        if (key === "order") meta.order = parseInt(val, 10);
      }
    }
  }

  return { meta, body };
};

// GET /api/docs - List all documents
router.get("/", async (_req: Request, res: Response) => {
  try {
    const docsDir = getDocsDir();
    if (!fs.existsSync(docsDir)) {
      res.json([]);
      return;
    }

    const files = fs.readdirSync(docsDir).filter((file) => file.endsWith(".md"));
    const docsList: DocMetadata[] = [];

    for (const file of files) {
      const slug = file.replace(/\.md$/, "");
      const fullPath = path.join(docsDir, file);
      const fileContent = fs.readFileSync(fullPath, "utf-8");
      const { meta } = parseFrontMatter(fileContent);

      docsList.push({
        slug,
        title: meta.title ?? slug,
        category: meta.category ?? "General",
        order: meta.order ?? 99,
      });
    }

    // Sort by category first, then by order
    docsList.sort((a, b) => {
      if (a.category !== b.category) {
        return a.category.localeCompare(b.category);
      }
      return a.order - b.order;
    });

    res.json(docsList);
  } catch (error) {
    res.status(500).json({ error: "Failed to load documents list" });
  }
});

// GET /api/docs/search - Search document contents
router.get("/search", async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string | undefined;
    if (!query?.trim()) {
      res.status(400).json({ error: "Query parameter 'q' is required" });
      return;
    }

    const searchStr = query.trim().toLowerCase();
    const docsDir = getDocsDir();
    if (!fs.existsSync(docsDir)) {
      res.json([]);
      return;
    }

    const files = fs.readdirSync(docsDir).filter((file) => file.endsWith(".md"));
    const results: { slug: string; title: string; category: string; snippet: string }[] = [];

    for (const file of files) {
      const slug = file.replace(/\.md$/, "");
      const fullPath = path.join(docsDir, file);
      const fileContent = fs.readFileSync(fullPath, "utf-8");
      const { meta, body } = parseFrontMatter(fileContent);

      const title = meta.title ?? slug;
      const category = meta.category ?? "General";
      const cleanBody = body.replace(/[#*`_-]/g, " ");

      if (
        title.toLowerCase().includes(searchStr) ||
        category.toLowerCase().includes(searchStr) ||
        cleanBody.toLowerCase().includes(searchStr)
      ) {
        // Generate snippet around first match
        let snippet = "";
        const idx = cleanBody.toLowerCase().indexOf(searchStr);
        if (idx !== -1) {
          const start = Math.max(0, idx - 40);
          const end = Math.min(cleanBody.length, idx + searchStr.length + 60);
          snippet = cleanBody.substring(start, end).replace(/\s+/g, " ").trim();
          if (start > 0) snippet = "..." + snippet;
          if (end < cleanBody.length) snippet = snippet + "...";
        } else {
          snippet = cleanBody.substring(0, 100).replace(/\s+/g, " ").trim() + "...";
        }

        results.push({
          slug,
          title,
          category,
          snippet,
        });
      }
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: "Search failed" });
  }
});

// GET /api/docs/:slug - Get document details
router.get("/:slug", async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug;
    if (!slug || typeof slug !== "string") {
      res.status(400).json({ error: "Slug is required" });
      return;
    }

    const cleanSlug = slug.replace(/[^a-zA-Z0-9_-]/g, "");
    const docsDir = getDocsDir();
    const filePath = path.resolve(docsDir, `${cleanSlug}.md`);

    // Prevent directory traversal attacks
    if (!filePath.startsWith(docsDir)) {
      res.status(403).json({ error: "Forbidden path" });
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const fileContent = fs.readFileSync(filePath, "utf-8");
    const { meta, body } = parseFrontMatter(fileContent);

    const doc: DocContent = {
      slug: cleanSlug,
      title: meta.title ?? cleanSlug,
      category: meta.category ?? "General",
      order: meta.order ?? 99,
      content: body.trim(),
    };

    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: "Failed to load document content" });
  }
});

export default router;
