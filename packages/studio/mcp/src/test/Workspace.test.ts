import * as fs from "node:fs"
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {checksumOf, copyBytes, RequestRecord, Workspace} from "../Workspace"
import {emptyProject, temporaryDirectory} from "./Fixture"

vi.mock("node:fs", async importOriginal => ({...await importOriginal<typeof fs>()}))

afterEach(() => vi.restoreAllMocks())

describe("workspace commits", () => {
    let workspace: Workspace
    let initial: Buffer

    beforeEach(() => {
        workspace = new Workspace(temporaryDirectory())
        workspace.create(emptyProject())
        initial = fs.readFileSync(workspace.projectFile)
    })

    const edit = () => {
        const graph = workspace.loadGraph()
        graph.beginTransaction()
        ProjectSkeleton.findMandatoryBoxes(graph).timelineBox.bpm.setValue(90)
        graph.endTransaction()
        const record: RequestRecord = {
            id: "tempo", label: "Tempo", status: "applied", message: null, output: [], undoes: null,
            updates: "", checksum: checksumOf(graph), time: new Date().toISOString()
        }
        return {graph, record}
    }

    it("leaves the project and history untouched when writing the request fails", () => {
        const {graph, record} = edit()
        const write = fs.writeFileSync
        vi.spyOn(fs, "writeFileSync").mockImplementation((path, data, options) => {
            if (String(path).endsWith("record.json")) {throw new Error("Disk full")}
            write(path, data, options)
        })
        expect(() => workspace.commitRequest(graph, record, "project.bpm = 90")).toThrow("Disk full")
        expect(fs.readFileSync(workspace.projectFile)).toEqual(initial)
        expect(workspace.undoTarget().isEmpty()).true
        expect(fs.readdirSync(workspace.requestsDirectory)).toEqual([])
    })

    it.each(["script", "record", "project"])("rolls back when publishing the %s fails", failed => {
        const {graph, record} = edit()
        const rename = fs.renameSync
        vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
            const path = String(destination)
            if (failed === "script" && path.endsWith(".ts") || failed === "record" && path.endsWith(".json")
                || failed === "project" && path === workspace.projectFile) {throw new Error("Save failed")}
            rename(source, destination)
        })
        expect(() => workspace.commitRequest(graph, record, "project.bpm = 90")).toThrow("Save failed")
        expect(fs.readFileSync(workspace.projectFile)).toEqual(initial)
        expect(workspace.undoTarget().isEmpty()).true
        expect(fs.readdirSync(workspace.requestsDirectory)).toEqual([])
        vi.restoreAllMocks()
        workspace.commitRequest(graph, record, "project.bpm = 90")
        expect(checksumOf(workspace.loadGraph())).toBe(record.checksum)
        expect(workspace.undoTarget().unwrap().id).toBe(record.id)
    })

    it("keeps the undo target when its undo record cannot be published", () => {
        const {graph, record} = edit()
        workspace.commitRequest(graph, record, "project.bpm = 90")
        const beforeUndo = fs.readFileSync(workspace.projectFile)
        const undoRecord = {...record, id: "undo-tempo", undoes: record.id, updates: null, checksum: null}
        const original = ProjectSkeleton.decode(copyBytes(initial)).boxGraph
        const rename = fs.renameSync
        vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
            if (String(destination).endsWith(".json")) {throw new Error("History unavailable")}
            rename(source, destination)
        })
        expect(() => workspace.commitRequest(original, undoRecord, null)).toThrow("History unavailable")
        expect(fs.readFileSync(workspace.projectFile)).toEqual(beforeUndo)
        expect(workspace.undoTarget().unwrap().id).toBe(record.id)
        vi.restoreAllMocks()
        workspace.commitRequest(original, undoRecord, null)
        expect(checksumOf(workspace.loadGraph())).toBe(checksumOf(original))
        expect(workspace.undoTarget().isEmpty()).true
    })

    it("recovers an incomplete commit before it reads the history or project", () => {
        const {graph, record} = edit()
        const rename = fs.renameSync
        const remove = fs.rmSync
        vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
            if (destination === workspace.projectFile) {throw new Error("Project unavailable")}
            rename(source, destination)
        })
        vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
            if (String(path).endsWith(".json")) {throw new Error("Cleanup unavailable")}
            remove(path, options)
        })
        expect(() => workspace.commitRequest(graph, record, "project.bpm = 90")).toThrow("Project unavailable")
        expect(fs.readFileSync(workspace.projectFile)).toEqual(initial)
        vi.restoreAllMocks()
        const reopened = new Workspace(workspace.directory)
        expect(reopened.undoTarget().isEmpty()).true
        expect(checksumOf(reopened.loadGraph())).not.toBe(record.checksum)
        expect(fs.readdirSync(workspace.requestsDirectory)).toEqual([])
    })

    it("keeps a completed commit when cleanup must be retried by the next command", () => {
        const {graph, record} = edit()
        const remove = fs.rmSync
        vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
            if (String(path).endsWith(".pending-request")) {throw new Error("Cleanup unavailable")}
            remove(path, options)
        })
        expect(() => workspace.commitRequest(graph, record, "project.bpm = 90")).not.toThrow()
        vi.restoreAllMocks()
        const reopened = new Workspace(workspace.directory)
        expect(checksumOf(reopened.loadGraph())).toBe(record.checksum)
        expect(reopened.undoTarget().unwrap().id).toBe(record.id)
    })
})
