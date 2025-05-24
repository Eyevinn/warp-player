#!/bin/bash
# Script to convert old logger function calls to the new format

# Convert info logs
find /Users/tobbe/proj/github/ev/moq-workspace/warp-player/src -name "*.ts" -exec sed -i '' -E 's/this\.logger\(([^,]*),\s*'"'"'info'"'"'([^)]*)\)/this.logger.info(\1\2)/g' {} \;

# Convert error logs
find /Users/tobbe/proj/github/ev/moq-workspace/warp-player/src -name "*.ts" -exec sed -i '' -E 's/this\.logger\(([^,]*),\s*'"'"'error'"'"'([^)]*)\)/this.logger.error(\1\2)/g' {} \;

# Convert success logs (map to info)
find /Users/tobbe/proj/github/ev/moq-workspace/warp-player/src -name "*.ts" -exec sed -i '' -E 's/this\.logger\(([^,]*),\s*'"'"'success'"'"'([^)]*)\)/this.logger.info(\1\2)/g' {} \;

# Convert warn logs
find /Users/tobbe/proj/github/ev/moq-workspace/warp-player/src -name "*.ts" -exec sed -i '' -E 's/this\.logger\(([^,]*),\s*'"'"'warn'"'"'([^)]*)\)/this.logger.warn(\1\2)/g' {} \;

# Convert logs without a level (map to info)
find /Users/tobbe/proj/github/ev/moq-workspace/warp-player/src -name "*.ts" -exec sed -i '' -E 's/this\.logger\(([^,)]*)\)/this.logger.info(\1)/g' {} \;

echo "Conversion complete!"