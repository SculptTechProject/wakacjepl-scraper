import { ConfigurationError, main } from "./src/main";
import { HttpError } from "./src/http/HttpError";

if (import.meta.main) {
  try {
    await main();
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      console.error(error.message);
    } else if (error instanceof HttpError) {
      console.error(`Request failed: HTTP ${error.status} (${error.method}).`);
    } else if (error instanceof DOMException && error.name === "TimeoutError") {
      console.error("Request timed out.");
    } else if (error instanceof Error && error.name === "AbortError") {
      console.error("Collection interrupted. Committed pages remain in the database.");
    } else {
      const kind = error instanceof Error ? error.name : "UnknownError";
      console.error(`Application failed (${kind}). Check the options, .env.example, and connectivity.`);
    }
    // Do not dump error objects: response headers and bodies may contain tokens.
    process.exitCode = 1;
  }
}
