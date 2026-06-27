import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Search, BookOpen, ChevronRight, FileText, Loader2, Bot, ArrowRight, Menu, X, Home } from "lucide-react";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { useAuth } from "../lib/auth";

interface DocMeta {
  slug: string;
  title: string;
  category: string;
  order: number;
}

interface DocContent extends DocMeta {
  content: string;
}

interface SearchResult {
  slug: string;
  title: string;
  category: string;
  snippet: string;
}

export function Docs() {
  const { user } = useAuth();
  const { slug } = useParams<{ slug?: string }>();
  const navigate = useNavigate();

  const [docsList, setDocsList] = useState<DocMeta[]>([]);
  const [activeDoc, setActiveDoc] = useState<DocContent | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingContent, setLoadingContent] = useState(false);
  const [searching, setSearching] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Fetch list of documents on mount
  useEffect(() => {
    async function fetchDocsList() {
      try {
        const res = await fetch("/api/docs");
        if (res.ok) {
          const data = (await res.json()) as DocMeta[];
          setDocsList(data);
        }
      } catch (err) {
        console.error("Error fetching docs list", err);
      } finally {
        setLoadingList(false);
      }
    }
    fetchDocsList();
  }, []);

  // Redirect to default doc if no slug is provided
  useEffect(() => {
    if (!slug && docsList.length > 0) {
      const defaultDoc = docsList.find((d) => d.slug === "introduction") || docsList[0];
      if (defaultDoc) {
        navigate(`/docs/${defaultDoc.slug}`, { replace: true });
      }
    }
  }, [slug, docsList, navigate]);

  // Fetch active document when slug changes
  useEffect(() => {
    if (!slug) return;

    async function fetchDocContent() {
      setLoadingContent(true);
      try {
        const res = await fetch(`/api/docs/${slug}`);
        if (res.ok) {
          const data = (await res.json()) as DocContent;
          setActiveDoc(data);
        } else {
          setActiveDoc(null);
        }
      } catch (err) {
        console.error("Error fetching doc content", err);
        setActiveDoc(null);
      } finally {
        setLoadingContent(false);
      }
    }
    fetchDocContent();
  }, [slug]);

  // Handle live search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    const delayDebounceFn = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/docs/search?q=${encodeURIComponent(searchQuery)}`);
        if (res.ok) {
          const data = (await res.json()) as SearchResult[];
          setSearchResults(data);
        }
      } catch (err) {
        console.error("Error searching docs", err);
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => clearTimeout(delayDebounceFn);
  }, [searchQuery]);

  // Group documents by category for sidebar navigation
  const groupedDocs = docsList.reduce<Record<string, DocMeta[]>>((acc, doc) => {
    if (!acc[doc.category]) {
      acc[doc.category] = [];
    }
    acc[doc.category]!.push(doc);
    return acc;
  }, {});

  // Parse headings from current document for Table of Contents
  const getTableOfContents = () => {
    if (!activeDoc) return [];
    const lines = activeDoc.content.split("\n");
    const headings: { text: string; id: string; level: number }[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("## ") || trimmed.startsWith("### ")) {
        const level = trimmed.startsWith("## ") ? 2 : 3;
        const text = trimmed.substring(level + 1).trim().replace(/[#*`_-]/g, "");
        const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        headings.push({ text, id, level });
      }
    }
    return headings;
  };

  const toc = getTableOfContents();

  return (
    <div className="min-h-screen bg-main-bg text-main-text selection:bg-brand-500/30 overflow-x-hidden font-sans flex flex-col">
      {/* Background glow effects */}
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-brand-500/10 rounded-full filter blur-[120px] pointer-events-none" />
      <div className="absolute top-[800px] right-1/4 w-[500px] h-[500px] bg-indigo-500/5 rounded-full filter blur-[160px] pointer-events-none" />

      {/* Header / Navigation */}
      <header className="sticky top-0 z-50 backdrop-blur-md bg-main-bg/80 border-b border-sidebar-border">
        <div className="w-full max-w-full px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/" className="w-9 h-9 rounded-xl flex items-center justify-center hover:opacity-80 transition-opacity">
              <img src="/logo.png" alt="AstroidBot Logo" className="w-9 h-9 object-contain" />
            </Link>
            <div>
              <Link to="/" className="font-bold text-title-text text-lg tracking-tight hover:text-brand-400 transition-colors">AstroidBot</Link>
              <span className="text-xs block text-muted-text -mt-1 font-mono">DOCUMENTATION</span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <Link to="/" className="text-sm font-medium text-muted-text hover:text-title-text transition-colors flex items-center gap-1.5 py-1">
              <Home className="w-4 h-4" />
              <span className="hidden sm:inline">Home</span>
            </Link>
            {user ? (
              <Link
                to="/dashboard"
                className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-sm font-medium transition-all duration-200 shadow-lg shadow-brand-500/20"
              >
                Dashboard
                <ArrowRight className="w-4 h-4" />
              </Link>
            ) : (
              <>
                <Link
                  to="/login"
                  className="text-sm font-medium text-muted-text hover:text-title-text transition-colors px-2 py-1"
                >
                  Sign In
                </Link>
                <Link
                  to="/register"
                  className="hidden sm:inline-block px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-sm font-medium transition-all duration-200 shadow-lg shadow-brand-500/20"
                >
                  Get Started
                </Link>
              </>
            )}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="lg:hidden p-2 text-muted-text hover:text-title-text rounded-lg bg-bg-hover border border-divider-color transition-colors"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <div className="flex-1 w-full max-w-full px-6 py-8 flex flex-col lg:flex-row gap-8 relative">
        
        {/* Sidebar Navigation - Desktop */}
        <aside className="hidden lg:block w-72 shrink-0 space-y-6">
          {/* Search Panel */}
          <div className="glass-card p-4 relative">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-text" />
              <input
                type="text"
                placeholder="Search docs..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="input-premium"
              />
            </div>

            {/* Search Results Dropdown */}
            {searchQuery.trim() !== "" && (
              <div className="absolute left-0 right-0 mt-2 glass-card shadow-2xl z-30 max-h-80 overflow-y-auto p-2 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-muted-text font-bold px-3 py-1">
                  {searching ? "Searching..." : `${searchResults.length} Search Results`}
                </div>
                {searchResults.length === 0 && !searching && (
                  <div className="text-sm text-muted-text px-3 py-2">No matches found.</div>
                )}
                {searchResults.map((result) => (
                  <Link
                    key={result.slug}
                    to={`/docs/${result.slug}`}
                    onClick={() => setSearchQuery("")}
                    className="block p-2 rounded-lg hover:bg-bg-hover transition-colors text-left"
                  >
                    <div className="text-sm font-semibold text-title-text truncate">
                      {result.title}
                    </div>
                    <div className="text-xs text-brand-400 font-medium mb-1">
                      {result.category}
                    </div>
                    <div className="text-xs text-muted-text line-clamp-2">
                      {result.snippet}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Grouped Links */}
          <div className="glass-card p-4 space-y-4">
            <div className="flex items-center gap-2 text-title-text font-semibold px-2">
              <BookOpen className="w-4 h-4 text-brand-400" />
              <span className="text-sm">Documentation</span>
            </div>

            {loadingList ? (
              <div className="flex justify-center p-6">
                <Loader2 className="w-5 h-5 text-brand-400 animate-spin" />
              </div>
            ) : (
              <nav className="space-y-4">
                {Object.entries(groupedDocs).map(([category, items]) => (
                  <div key={category} className="space-y-1">
                    <h4 className="text-xs font-bold text-muted-text uppercase tracking-wider px-2 py-1 select-none">
                      {category}
                    </h4>
                    <div className="space-y-0.5">
                      {items.map((item) => {
                        const isActive = slug === item.slug;
                        return (
                          <Link
                            key={item.slug}
                            to={`/docs/${item.slug}`}
                            className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
                              isActive
                                ? "bg-brand-500/20 text-brand-400 font-semibold"
                                : "text-muted-text hover:text-title-text hover:bg-bg-hover"
                            }`}
                          >
                            <span className="truncate">{item.title}</span>
                            {isActive && <ChevronRight className="w-3.5 h-3.5" />}
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </nav>
            )}
          </div>
        </aside>

        {/* Mobile Navigation Drawer */}
        {mobileMenuOpen && (
          <div className="lg:hidden fixed inset-0 z-40 bg-main-bg/95 backdrop-blur-md pt-20 px-6 overflow-y-auto">
            <div className="relative mb-6">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-text" />
              <input
                type="text"
                placeholder="Search docs..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="input-premium"
              />
              {searchQuery.trim() !== "" && (
                <div className="absolute left-0 right-0 mt-2 glass-card shadow-2xl z-50 max-h-60 overflow-y-auto p-2 space-y-1">
                  {searchResults.map((result) => (
                    <Link
                      key={result.slug}
                      to={`/docs/${result.slug}`}
                      onClick={() => {
                        setSearchQuery("");
                        setMobileMenuOpen(false);
                      }}
                      className="block p-2 rounded-lg hover:bg-bg-hover transition-colors text-left"
                    >
                      <div className="text-sm font-semibold text-title-text truncate">{result.title}</div>
                      <div className="text-xs text-brand-400 font-medium mb-1">{result.category}</div>
                      <div className="text-xs text-muted-text line-clamp-2">{result.snippet}</div>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-4 mb-12">
              <div className="flex items-center gap-2 text-title-text font-semibold px-2">
                <BookOpen className="w-4 h-4 text-brand-400" />
                <span className="text-sm">Documentation</span>
              </div>
              <nav className="space-y-4">
                {Object.entries(groupedDocs).map(([category, items]) => (
                  <div key={category} className="space-y-1">
                    <h4 className="text-xs font-bold text-muted-text uppercase tracking-wider px-2 py-1 select-none">
                      {category}
                    </h4>
                    <div className="space-y-0.5">
                      {items.map((item) => {
                        const isActive = slug === item.slug;
                        return (
                          <Link
                            key={item.slug}
                            to={`/docs/${item.slug}`}
                            onClick={() => setMobileMenuOpen(false)}
                            className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
                              isActive
                                ? "bg-brand-500/20 text-brand-400 font-semibold"
                                : "text-muted-text hover:text-title-text hover:bg-bg-hover"
                            }`}
                          >
                            <span className="truncate">{item.title}</span>
                            {isActive && <ChevronRight className="w-3.5 h-3.5" />}
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </nav>
            </div>
          </div>
        )}

        {/* Main Content Pane */}
        <main className="flex-1 min-w-0 glass-card rounded-2xl p-6 sm:p-8">
          {loadingContent ? (
            <div className="min-h-[400px] flex items-center justify-center">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="w-8 h-8 text-brand-400 animate-spin" />
                <p className="text-sm text-muted-text">Loading document...</p>
              </div>
            </div>
          ) : activeDoc ? (
            <article className="prose prose-invert max-w-none">
              <div className="flex items-center gap-1 text-xs text-brand-400 font-semibold mb-4 uppercase tracking-wider">
                <span>{activeDoc.category}</span>
                <ChevronRight className="w-3 h-3 text-muted-text" />
                <span className="text-muted-text">{activeDoc.title}</span>
              </div>
              <MarkdownRenderer content={activeDoc.content} />
            </article>
          ) : (
            <div className="min-h-[400px] flex flex-col items-center justify-center text-center p-6 border border-dashed border-divider-color rounded-2xl">
              <FileText className="w-12 h-12 text-muted-text mb-3" />
              <h3 className="text-lg font-bold text-title-text mb-1">Doc Not Found</h3>
              <p className="text-sm text-muted-text max-w-sm">
                The documentation page you requested does not exist or has been moved.
              </p>
            </div>
          )}
        </main>

        {/* Table of Contents - Right Pane */}
        {toc.length > 0 && !loadingContent && (
          <aside className="hidden xl:block w-56 shrink-0">
            <div className="sticky top-24 space-y-4">
              <h4 className="text-xs font-bold text-muted-text uppercase tracking-wider px-2">
                On this page
              </h4>
              <nav className="space-y-2 border-l border-divider-color pl-2">
                {toc.map((heading) => (
                  <a
                    key={heading.id}
                    href={`#${heading.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      const el = document.getElementById(heading.id);
                      if (el) {
                        el.scrollIntoView({ behavior: "smooth" });
                      }
                    }}
                    className={`block text-xs text-muted-text hover:text-brand-400 transition-colors py-0.5 truncate ${
                      heading.level === 3 ? "pl-3 opacity-70" : ""
                    }`}
                  >
                    {heading.text}
                  </a>
                ))}
              </nav>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
