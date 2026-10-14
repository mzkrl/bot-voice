const path = require("node:path");

const LOGS_DIR = path.join(__dirname, "logs");

module.exports = {
  apps: [
    {
      name: "bot-voice-keeper",
      script: "index.js",
      interpreter: "node",
      cwd: __dirname,
      exp_backoff_restart_delay: 100,
      watch: false,
      max_memory_restart: "500M",
      out_file: path.join(LOGS_DIR, "bot-voice-out.log"),
      error_file: path.join(LOGS_DIR, "bot-voice-err.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm Z",
    },
  ],
};
