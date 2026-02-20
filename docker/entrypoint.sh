#!/bin/bash
set -e

echo "Starting Linux Update Dashboard..."

# Run database migrations if drizzle directory exists
if [ -d "drizzle" ]; then
  echo "Running database migrations..."
  bun run db:migrate 2>/dev/null || echo "Migrations skipped (tables may already exist)"
fi

# Execute the main command
exec "$@"
