import { Link } from 'gatsby';
import React from 'react';

export interface PaginationProps {
    previousPagePath: string;
    nextPagePath: string;
    previousPageButtonText: string;
    nextPageButtonText: string;
    humanPageNumber: number;
    numberOfPages: number;
    className?: string;
}

export const Pagination = ({ previousPagePath, nextPagePath, previousPageButtonText, nextPageButtonText, humanPageNumber, numberOfPages, className }: PaginationProps) => {
    return (
        <nav aria-label="Pagination" className={`mt-12 flex items-center justify-between gap-4 border-t border-line pt-6 ${className ?? ''}`}>
          <div className="flex flex-1">
            {previousPagePath ? (
              <Link to={previousPagePath} rel="prev" className="btn-outline btn-sm">← {previousPageButtonText}</Link>) : null}
          </div>
          <span className="text-sm text-muted">Page {humanPageNumber} of {numberOfPages}</span>
          <div className="flex flex-1 justify-end">
            {nextPagePath ? (
              <Link to={nextPagePath} rel="next" className="btn-outline btn-sm">{nextPageButtonText} →</Link>) : null}
          </div>
        </nav>
    );
};
