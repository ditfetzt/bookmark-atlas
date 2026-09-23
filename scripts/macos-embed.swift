// On-device sentence embeddings via macOS NaturalLanguage.
//
// Reads a JSON array of strings from stdin, writes a JSON array of vectors
// (512 floats each) to stdout. No network, no model download, no third-party
// dependency — it uses the embedding model built into macOS.
//
// Bookmark Atlas compiles this once into the user data directory (see
// atlasDataDir() in src/db.ts) and reuses the binary from there.

import Foundation
import NaturalLanguage

let input = FileHandle.standardInput.readDataToEndOfFile()
guard
    let texts = try? JSONSerialization.jsonObject(with: input) as? [String],
    let embedding = NLEmbedding.sentenceEmbedding(for: .english)
else {
    FileHandle.standardError.write(Data("macos-embed: sentence embedding unavailable\n".utf8))
    exit(1)
}

var vectors: [[Double]] = []
vectors.reserveCapacity(texts.count)
for text in texts {
    vectors.append(embedding.vector(for: text) ?? [])
}

do {
    let json = try JSONSerialization.data(withJSONObject: vectors)
    FileHandle.standardOutput.write(json)
} catch {
    FileHandle.standardError.write(Data("macos-embed: failed to encode vectors\n".utf8))
    exit(1)
}
