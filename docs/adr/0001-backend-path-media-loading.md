# Backend Path Media Loading

Sibling subtitle discovery uses a backend path API plus backend-served media URLs instead of browser `File` sibling discovery. Browsers do not expose same-folder files from a single file input, so the backend owns validating an absolute video path, scanning the containing directory, and serving only registered files through opaque IDs.
