declare module 'got-scraping' {
  export interface GotScrapingResponse<T = string> {
    body: T;
    statusCode: number;
    headers?: Record<string, string | string[] | undefined>;
  }

  export interface GotScrapingOptions {
    url: string;
    [key: string]: any;
  }

  export function gotScraping<T = string>(options: GotScrapingOptions): Promise<GotScrapingResponse<T>>;
}
