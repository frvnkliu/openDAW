import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs"
import {basename, join, resolve} from "node:path"
import {isDefined, Nullable, Option, panic, tryCatch} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"

export type RequestStatus = "applied" | "unchanged" | "invalid" | "failed" | "timeout"

// updates: the recorded edits that undo inverts (base64); checksum: the project after an applied script
export type RequestRecord = {
    id: string
    label: string
    status: RequestStatus
    message: Nullable<string>
    output: ReadonlyArray<string>
    undoes: Nullable<string>
    updates: Nullable<string>
    checksum: Nullable<string>
    time: string
}

export const copyBytes = (bytes: Uint8Array): ArrayBuffer =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

export const checksumOf = (graph: BoxGraph): string => Buffer.from(graph.checksum()).toString("hex")

export class Workspace {
    readonly directory: string

    constructor(directory: string) {this.directory = resolve(directory)}

    get name(): string {return basename(this.directory)}
    get projectFile(): string {return join(this.directory, "project.od")}
    get requestsDirectory(): string {return join(this.directory, "requests")}
    get #pendingDirectory(): string {return join(this.directory, ".pending-request")}

    create(project: ArrayBuffer): void {
        if (existsSync(this.projectFile)) {return panic(`${this.directory} already holds a project`)}
        mkdirSync(this.directory, {recursive: true})
        this.#write(this.projectFile, new Uint8Array(project))
    }

    loadGraph(): BoxGraph<BoxIO.TypeMap> {
        this.#recover()
        if (!existsSync(this.projectFile)) {return panic(`No project in ${this.directory}. Run 'init' first.`)}
        return ProjectSkeleton.decode(copyBytes(readFileSync(this.projectFile))).boxGraph
    }

    saveGraph(graph: BoxGraph): void {
        this.#recover()
        this.#write(this.projectFile, new Uint8Array(ProjectSkeleton.encode(graph)))
    }

    saveRecord(record: RequestRecord, script: Nullable<string>): void {
        const stem = this.#recordStem(record)
        if (isDefined(script)) {this.#write(`${stem}.ts`, script)}
        this.#write(`${stem}.json`, JSON.stringify(record, null, 2) + "\n")
    }

    commitRequest(graph: BoxGraph, record: RequestRecord, script: Nullable<string>): void {
        const stem = this.#recordStem(record)
        const staging = mkdtempSync(join(this.directory, ".request-"))
        let published = false
        try {
            writeFileSync(join(staging, "project.od"), new Uint8Array(ProjectSkeleton.encode(graph)))
            writeFileSync(join(staging, "record.json"), JSON.stringify(record, null, 2) + "\n")
            if (isDefined(script)) {writeFileSync(join(staging, "script.ts"), script)}
            writeFileSync(join(staging, "stem"), basename(stem))
            // Publish the recovery data only after every file is ready. One writer owns this workspace.
            renameSync(staging, this.#pendingDirectory)
            published = true
            if (isDefined(script)) {renameSync(join(this.#pendingDirectory, "script.ts"), `${stem}.ts`)}
            renameSync(join(this.#pendingDirectory, "record.json"), `${stem}.json`)
            // The project rename is the commit point. Its undo record is already in place.
            renameSync(join(this.#pendingDirectory, "project.od"), this.projectFile)
        } catch (error) {
            // If cleanup fails, leave the journal so the next command retries recovery before it reads anything.
            tryCatch(() => published ? this.#recover() : rmSync(staging, {recursive: true, force: true}))
            throw error
        }
        // A cleanup error must not report a committed request as failed.
        tryCatch(() => this.#recover())
    }

    #recordStem(record: RequestRecord): string {
        mkdirSync(this.requestsDirectory, {recursive: true})
        const number = this.#recordFiles().length + 1
        return join(this.requestsDirectory, `${String(number).padStart(4, "0")}-${record.id}`)
    }

    // The newest applied request that no applied undo took back
    undoTarget(): Option<RequestRecord> {
        const stack: Array<RequestRecord> = []
        this.#recordFiles()
            .map(name => JSON.parse(readFileSync(join(this.requestsDirectory, name), "utf8")) as RequestRecord)
            .filter(record => record.status === "applied")
            .forEach(record => isDefined(record.undoes) ? stack.pop() : stack.push(record))
        return Option.wrap(stack.at(-1))
    }

    #recordFiles(): ReadonlyArray<string> {
        this.#recover()
        return existsSync(this.requestsDirectory)
            ? readdirSync(this.requestsDirectory).filter(name => name.endsWith(".json")).toSorted() : []
    }

    #recover(): void {
        const pending = this.#pendingDirectory
        if (!existsSync(pending)) {return}
        if (existsSync(join(pending, "project.od"))) {
            // The staged project still exists, so the atomic rename did not commit. Remove its history.
            const stem = join(this.requestsDirectory, readFileSync(join(pending, "stem"), "utf8"))
            rmSync(`${stem}.json`, {force: true})
            rmSync(`${stem}.ts`, {force: true})
        }
        // Otherwise the rename committed and its history must stay in place.
        rmSync(pending, {recursive: true, force: true})
    }

    #write(path: string, data: Uint8Array | string): void {
        const temporary = `${path}.${process.pid}`
        writeFileSync(temporary, data)
        renameSync(temporary, path)
    }
}
