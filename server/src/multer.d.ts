declare module 'multer' {
  import type { Request, RequestHandler } from 'express';

  interface MulterFile {
    fieldname: string;
    originalname: string;
    encoding: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
  }

  interface MulterError extends Error {
    code: string;
    field?: string;
    storageErrors?: Error[];
  }

  interface MulterInstance {
    single(fieldName: string): RequestHandler;
  }

  interface MulterOptions {
    storage?: unknown;
    limits?: {
      fileSize?: number;
    };
    fileFilter?: (
      req: Request,
      file: MulterFile,
      callback: (error: Error | null, acceptFile?: boolean) => void,
    ) => void;
  }

  interface MulterFactory {
    (options?: MulterOptions): MulterInstance;
    memoryStorage(): unknown;
    MulterError: new (message?: string) => MulterError;
  }

  const multer: MulterFactory;
  export = multer;
}
