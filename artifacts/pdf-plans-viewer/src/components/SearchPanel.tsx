import React, { useState } from 'react';
import { useViewerContext } from '../store/ViewerContext';
import { extractTextContent } from '../lib/pdfUtils';
import { Search, Loader2, AlertCircle } from 'lucide-react';
import { SearchResult } from '../types';

export default function SearchPanel() {
  const { state, dispatch } = useViewerContext();
  const { pdfDoc, totalPages, searchQuery, searchResults, isSearching } = state;
  const [query, setQuery] = useState(searchQuery);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim() || !pdfDoc) return;

    dispatch({ type: 'SET_SEARCH_STATE', query, results: [], isSearching: true });

    const results: SearchResult[] = [];
    const searchLower = query.toLowerCase();

    try {
      for (let i = 1; i <= totalPages; i++) {
        const items = await extractTextContent(pdfDoc, i);
        let fullText = items.map((it: any) => it.str).join(' ');
        
        // Simple search (can be enhanced with regex)
        let startIndex = 0;
        let index = fullText.toLowerCase().indexOf(searchLower, startIndex);
        
        while (index > -1) {
          const snippetStart = Math.max(0, index - 40);
          const snippetEnd = Math.min(fullText.length, index + searchLower.length + 40);
          const snippet = "..." + fullText.substring(snippetStart, snippetEnd).trim() + "...";
          
          results.push({
            pageNumber: i,
            snippet,
            matchIndex: index,
            transform: [] // Approximate position could be calculated
          });
          
          startIndex = index + searchLower.length;
          index = fullText.toLowerCase().indexOf(searchLower, startIndex);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      dispatch({ type: 'SET_SEARCH_STATE', query, results, isSearching: false });
    }
  };

  const handleResultClick = (pageNum: number) => {
    dispatch({ type: 'SET_CURRENT_PAGE', page: pageNum });
  };

  if (!pdfDoc) {
    return (
      <div className="h-full flex items-center justify-center text-sidebar-foreground/50 text-sm">
        No document loaded
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b border-sidebar-border">
        <form onSubmit={handleSearch} className="relative">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search text..."
            className="w-full bg-background/10 text-sidebar-foreground border border-sidebar-border rounded pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:border-primary transition-colors"
          />
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sidebar-foreground/50" />
          <button type="submit" className="hidden">Search</button>
        </form>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isSearching ? (
          <div className="flex flex-col items-center justify-center h-32 text-sidebar-foreground/50 text-sm gap-2">
            <Loader2 className="animate-spin" size={20} />
            Searching all pages...
          </div>
        ) : searchResults.length > 0 ? (
          <div className="p-4 space-y-4">
            <div className="text-xs font-medium text-sidebar-foreground/70 uppercase tracking-wider mb-2">
              {searchResults.length} Results Found
            </div>
            {searchResults.map((res, i) => (
              <div 
                key={i} 
                onClick={() => handleResultClick(res.pageNumber)}
                className="bg-background/5 border border-sidebar-border p-3 rounded cursor-pointer hover:border-primary/50 transition-colors group"
              >
                <div className="text-xs font-medium text-primary mb-1 flex justify-between">
                  <span>Page {res.pageNumber}</span>
                </div>
                <div 
                  className="text-sm text-sidebar-foreground/90 line-clamp-3 leading-snug"
                  dangerouslySetInnerHTML={{ 
                    __html: res.snippet.replace(new RegExp(query, 'gi'), match => `<mark class="bg-primary/30 text-primary font-medium rounded px-0.5">${match}</mark>`) 
                  }}
                />
              </div>
            ))}
          </div>
        ) : query && !isSearching && searchQuery ? (
          <div className="flex flex-col items-center justify-center h-32 text-sidebar-foreground/50 text-sm gap-2 p-4 text-center">
            <AlertCircle size={20} className="text-sidebar-foreground/30" />
            No matches found for "{searchQuery}"
          </div>
        ) : (
          <div className="p-4 text-sidebar-foreground/50 text-sm text-center mt-10">
            Enter text to search across all pages
          </div>
        )}
      </div>
    </div>
  );
}
