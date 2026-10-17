import {existsSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import {beforeEach, describe, expect, it} from "vitest"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {runRequest, undoRequest} from "../Requests"
import {checksumOf, Workspace} from "../Workspace"
import {emptyProject, temporaryDirectory} from "./Fixture"

const ADD_LEAD = `const project = await openDAW.getProject()
project.addInstrumentUnit("Vaporisateur", {label: "Lead"})
project.openInStudio()`

const TEMPO = "const project = await openDAW.getProject()\nproject.bpm = 90\nproject.openInStudio()"

describe("requests", () => {
    let workspace: Workspace
    let initial: string

    beforeEach(() => {
        workspace = new Workspace(temporaryDirectory())
        workspace.create(emptyProject())
        initial = checksumOf(workspace.loadGraph())
    })

    it("applies a script as one request and undo takes it back", async () => {
        const request = await runRequest(workspace, ADD_LEAD, "Lead")
        expect(request.status).toBe("applied")
        expect(request.checksum).toBe(checksumOf(workspace.loadGraph()))
        expect(request.checksum).not.toBe(initial)
        expect(undoRequest(workspace).unwrap().status).toBe("applied")
        expect(checksumOf(workspace.loadGraph())).toBe(initial)
        expect(undoRequest(workspace).isEmpty()).true
    })

    it("leaves the project untouched when request storage is unavailable", async () => {
        const before = readFileSync(workspace.projectFile)
        writeFileSync(workspace.requestsDirectory, "existing file")
        await expect(runRequest(workspace, TEMPO, "Tempo")).rejects.toThrow()
        expect(readFileSync(workspace.projectFile)).toEqual(before)
        rmSync(workspace.requestsDirectory)
        expect(undoRequest(workspace).isEmpty()).true
        expect((await runRequest(workspace, TEMPO, "Tempo")).status).toBe("applied")
        expect(undoRequest(workspace).unwrap().status).toBe("applied")
        expect(checksumOf(workspace.loadGraph())).toBe(initial)
    })

    it("undoes the requests newest first", async () => {
        await runRequest(workspace, ADD_LEAD, "Lead")
        const afterLead = checksumOf(workspace.loadGraph())
        await runRequest(workspace, TEMPO, "Tempo")
        expect(undoRequest(workspace).unwrap().label).toBe("Undo Tempo")
        expect(checksumOf(workspace.loadGraph())).toBe(afterLead)
        expect(undoRequest(workspace).unwrap().label).toBe("Undo Lead")
        expect(checksumOf(workspace.loadGraph())).toBe(initial)
    })

    it("undoes a script that adds a unit and sets its output to null", async () => {
        const request = await runRequest(workspace, `const project = await openDAW.getProject()
const trigger = project.addInstrumentUnit("Vaporisateur", {label: "Trigger"})
trigger.output = null
project.openInStudio()`, "Trigger")
        expect(request.status).toBe("applied")
        expect(undoRequest(workspace).unwrap().status).toBe("applied")
        expect(checksumOf(workspace.loadGraph())).toBe(initial)
    })

    it("needs a project before it checks a script", async () => {
        const missing = new Workspace(join(temporaryDirectory(), "missing"))
        await expect(runRequest(missing, "project.bpm = 1", "Tempo")).rejects.toThrow("No project in")
        expect(existsSync(missing.directory)).false
    })

    it("does not run a script with type errors", async () => {
        const request = await runRequest(workspace, "const project = await openDAW.getProject()\nproject.bpm = \"fast\"", "Tempo")
        expect(request.status).toBe("invalid")
        expect(request.message).toContain("line 2:1")
        expect(checksumOf(workspace.loadGraph())).toBe(initial)
    })

    it("changes nothing when the script does not call openInStudio", async () => {
        const request = await runRequest(workspace, "const project = await openDAW.getProject()\nconsole.log(project.bpm)", "Read")
        expect(request.status).toBe("unchanged")
        expect(request.output).toEqual(["120"])
        expect(undoRequest(workspace).isEmpty()).true
    })

    it("gives the script the tuning of the project", async () => {
        const graph = workspace.loadGraph()
        graph.beginTransaction()
        ProjectSkeleton.findMandatoryBoxes(graph).rootBox.baseFrequency.setValue(432)
        graph.endTransaction()
        workspace.saveGraph(graph)
        expect((await runRequest(workspace, "console.log(baseFrequency)", "Tuning")).output).toEqual(["432"])
    })

    it("does not apply a script when the project changed while it ran", async () => {
        const running = runRequest(workspace, ADD_LEAD, "Lead")
        const graph = workspace.loadGraph()
        graph.beginTransaction()
        ProjectSkeleton.findMandatoryBoxes(graph).timelineBox.bpm.setValue(100)
        graph.endTransaction()
        workspace.saveGraph(graph)
        const request = await running
        expect(request.status).toBe("failed")
        expect(request.message).toBe("The project changed while the script ran. Run it again.")
        expect(checksumOf(workspace.loadGraph())).toBe(checksumOf(graph))
    })

    it("does not undo after the project changed outside these tools", async () => {
        await runRequest(workspace, ADD_LEAD, "Lead")
        const graph = workspace.loadGraph()
        graph.beginTransaction()
        ProjectSkeleton.findMandatoryBoxes(graph).timelineBox.bpm.setValue(100)
        graph.endTransaction()
        workspace.saveGraph(graph)
        const undo = undoRequest(workspace).unwrap()
        expect(undo.status).toBe("failed")
        expect(undo.message).toContain("changed outside these tools")
        expect(checksumOf(workspace.loadGraph())).toBe(checksumOf(graph))
    })
})
