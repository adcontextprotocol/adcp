import type { FC, ReactNode } from "react";

// Ladle 5.1's declaration barrel resolves an internal .tsx source file under
// TypeScript 7. The application only consumes these public story/provider
// types, so keep type-checking on the supported public surface until Ladle's
// package declarations no longer expose its implementation sources.
declare module "@ladle/react" {
  export type Story<Props = Record<string, never>> = FC<Props>;

  export type GlobalProvider = FC<{
    children: ReactNode;
    [key: string]: unknown;
  }>;
}
