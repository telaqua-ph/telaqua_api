/**
 * server.js
 *
 * Entry point — loads env and starts the Express server.
 */

import "dotenv/config";
import app from "./app.js";

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Tel-Aqua API running at http://localhost:${PORT}`);
});
