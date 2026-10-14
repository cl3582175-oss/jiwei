declare module 'word-extractor' {
  export default class WordExtractor {
    extract(path: string): Promise<{ getBody(): string }>
  }
}
