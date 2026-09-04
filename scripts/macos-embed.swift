import Foundation
import NaturalLanguage

let input = FileHandle.standardInput.readDataToEndOfFile()
let texts = try JSONDecoder().decode([String].self, from: input)

guard let embedding = NLEmbedding.sentenceEmbedding(for: .english) else {
    FileHandle.standardError.write(Data("English sentence embeddings are unavailable\n".utf8))
    exit(2)
}

let vectors = texts.map { text -> [Double] in
    embedding.vector(for: text) ?? []
}

let output = try JSONEncoder().encode(vectors)
FileHandle.standardOutput.write(output)
