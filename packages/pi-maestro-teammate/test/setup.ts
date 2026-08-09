import { initializeTuiLocale } from "../src/tui/locale.ts";

// Legacy render assertions use the historical English default. Locale-specific
// tests set and restore their own runtime locale explicitly.
initializeTuiLocale("en");
