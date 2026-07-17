# Session-Scoped Subtitle Generation

Subtitle uploads and generated artifacts belong to a browser session workspace.
The backend allows one active generation job, supports cancellation, and deletes
the workspace when the client ends its session or it becomes inactive. This
keeps large local media and partial model output out of durable application state.
