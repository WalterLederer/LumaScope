# Dynamic database-backed image detail table

[Back to supported image formats](image-formats.md) · [Back to README](../README.md)

## Overview

LumaScope's image detail view presents a configurable, sortable table of image files and their associated metadata. The gallery/cache database supplies persisted file information and cache-related metadata used by the table and its status columns. The table can represent a large folder or gallery without creating a DOM row for every file at once.

The detail view supports both **Details** (with thumbnails) and **Details without thumbnails**. Its columns and display preferences are configurable, and column widths can be adjusted independently.

## Rendering many files

The table uses **row virtualization**:

- The complete sorted image collection determines the logical row count and scrollable table height.
- Only the rows around the current viewport are rendered as actual table rows.
- The renderer calculates the visible range from the scroll position, viewport height and row height.
- It keeps an overscan of **12 rows before and 12 rows after** the visible range to make scrolling smooth.
- Top and bottom spacer rows preserve the apparent position and total height of the complete list.
- As the user scrolls, the rendered row window is updated; the application does not need to keep one DOM element per file.

This design allows the detail table to display very large file collections while keeping the number of simultaneously rendered table rows bounded by the viewport size and overscan, rather than by the total number of files.

## Database-backed information

The table combines the image-file collection with information maintained by LumaScope's photo/cache database. Depending on the selected columns and available records, this includes file metadata, cache status, GPS/location information and other image details.

Database-backed cache-status lookups are requested in batches of up to **500 files**. This avoids issuing one large status request for every file individually. Results are associated with file paths so that status and metadata can be shown on the corresponding rows.

The table's virtualized rendering and the database lookup batching solve different problems: virtualization limits the number of rendered rows, while batching limits the size of individual database status requests.

## Sorting and interaction

- Detail columns can be sorted using the table headers.
- The table supports keyboard navigation and selection of rows.
- Column widths can be resized, and the action/menu column can be positioned at the left or right.
- The thumbnail-free detail mode uses the same virtualized table structure with a smaller row height.

## Scalability notes

The table is designed for collections containing many thousands of files and can render substantially larger collections without creating a corresponding number of DOM rows. The total file collection is still held and sorted by the gallery data layer; virtualization reduces DOM and layout work, but it does not mean the entire file inventory is streamed from SQLite one visible page at a time.

Actual loading time and memory use therefore also depend on directory enumeration, the size of the in-memory file collection, metadata availability and the selected columns. The 500-file batching applies to cache-status requests; it should not be interpreted as a fixed maximum table size.
