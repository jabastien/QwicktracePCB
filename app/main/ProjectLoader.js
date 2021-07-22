const { ipcMain } = require('electron')

const fse = require('fs-extra');
const whatsThatGerber = require('whats-that-gerber')
const gerbValid = require('whats-that-gerber').validate;
const path = require('path');
const fsprReadFile = require('fs').promises.readFile;


const dropDir = "./pcb-files/";
const workDir = "./temp/";


const MainSubProcess = require('./MainSubProcess.js');
const PCBProject = require('./pcb/PCBProject.js');
const GerberUtils = require('./pcb/GerberUtils.js');

// _projectCache is an object that maps a projectId to one or 
// more PCBProject() objects.
let _projectCache = {};

// _filesToProject is an object that maps a gerber or drill
// file name back to the PCBProject it is part of.
let _filesToProject = {};

// _currentProject holds the latest information concerning
// the most recent project prepared by prepareForWork().
let _currentProject = {};

class ProjectLoader  extends MainSubProcess {

    constructor(win) {

      super(win);

      this.lastFileSyncMs = 0;

       // Do a file list refresh now...
      this.refreshFileList();

       // And every 5 seconds after this...
      let thiz = this;
      setInterval(() => { thiz.refreshFileList(); }, 5000);

      ipcMain.handle('projectloader-prepare', (event, data) => {
         let { profile, callbackName } = data;
         console.log('Preparing project work directory using profile:', profile)
         ProjectLoader.prepareForWork(profile)
            .then(results => {
                console.log('Project work directory prep completed.')
                thiz.ipcSend(callbackName, profile)
            });
      });      
    }


    get projectCache() {
        return _projectCache;
    }

    get filesToProject() {
        return _filesToProject;
    }


    /**
     * Retrieves the fully qualified path and file name for the
     * specified projectId and side
     * @param {string} projectId A project Id previously read by the project laoder
     * @param {string} side  one of "top", "bottom", or "drill"
     * @returns The fully qualified path, or undefined if the definition does not exist.
     */
    static getFileName(projectId, side) {
        let project = _projectCache[projectId];
        if (project) {
            let sideFile = project.getSideFile(side);
            if (sideFile) {
                let res = project.dirName + "/" + sideFile;
                return res;
            }
        }

        return undefined;
    }


    /**
     * Initializes the project work directory by creating transformed files ready
     * for use by the system. Two files are created: side.gbr and side.drl. If
     * the side is bottom, it is mirrored.
     * @param {object} profile 
     */
    static async prepareForWork(profile) {
        let state = profile.state;
        let projectId = state.projectId;
        let project = _projectCache[projectId];

        try {
            let originalSize = await project.getSize();

            // Make sure board is wider than it is taller...
            let rotateBoard = (originalSize.y > originalSize.x);
            const clockwise = true;

            if (_currentProject.projectId != projectId) {
                // Start work on a new project...
                await fse.emptyDir(workDir);

                _currentProject = { projectId };
                if (rotateBoard) {
                    _currentProject.originalSize = { "x": originalSize.y, "y": originalSize.x };
                }
                else {
                    _currentProject.originalSize = { "x": originalSize.x, "y": originalSize.y };
                }
            }

            // Place a copy of gbr and drill files in the work directory.
            let side = state.side;
            let mirror = (side === 'bottom');
            let gbrTarget = workDir + side + ".gbr";
            let results = {};

            if (!fse.existsSync(gbrTarget)) {
               let fileName = project.getSideFile(side);
               if (fileName) {
                    let gbrSource = project.dirName + "/" + fileName;
                    if (rotateBoard) {
                        // Copy and rotate the files
                        await GerberUtils.rotateGbr90(gbrSource, gbrTarget, originalSize.x, originalSize.y, clockwise, mirror);
                    }
                    else {
                        // Copy the files as is...
                        await GerberUtils.transGbr(gbrSource, gbrTarget, 0, 0, 0, mirror);
                    }
                    results.gbr = gbrTarget;
                }
            }
            else {
                console.log('ProjectLoader.prepareForWork() is using existing Gerber file ', gbrTarget)
                results.gbr = gbrTarget;
            }


            let drlTarget = workDir + side + ".drl";
            if (!fse.existsSync(drlTarget)) {
               if (project.drillFile) {
                    let drlSource = project.dirName + "/" + project.drillFile;
                    if (rotateBoard) {
                        // Copy and rotate the files
                        await GerberUtils.rotateGbr90(drlSource, drlTarget, originalSize.x, originalSize.y, clockwise, mirror);
                    }
                    else {
                        // Copy the files as is...
                        await GerberUtils.transGbr(drlSource, drlTarget, 0, 0, 0, mirror);
                    }
                    results.drl = drlTarget;
                }
            }
            else {
                console.log('ProjectLoader.prepareForWork() is using existing drill file ', drlTarget)
                results.drl = drlTarget;
            }

            return results;

        }
        catch (err) {
            console.error(err);
        }
    }



    static async getWorkAsGcode(profile) {

        await ProjectLoader.prepareForWork(profile);

        let state = profile.state;

        let gbrSource = workDir + state.side + (state.action != 'drill' ? ".gbr" : ".drl");
        let gbrTarget;
        if (state.deskew) {
            gbrTarget = gbrSource + "-deskew";

            // Convert deskew's radians to degrees...
            let degRotation = state.deskew.rotation * 180 / Math.PI;
            // Convert deskew's counterclockwise rotation to +/- expected by GerberUtils...
            let gRotation = (degRotation <= 180) ? -degRotation : 360 - degRotation;
            let tx = state.deskew.offset.x;
            let ty = state.deskew.offset.y;
            await GerberUtils.transGbr(gbrSource, gbrTarget, gRotation, tx, ty, false);
        }
        else {
            gbrTarget = gbrSource;
        }

        let gcTarget = workDir + state.side + "-" + state.action + ".nc"

        if (state.action === 'mill') {
           await GerberUtils.gbrToMill(gbrTarget, gcTarget);
        }
        else {
            await GerberUtils.drlToDrill(gbrTarget, gcTarget);
        }

        // Read in the contents of the gcode file...
        let contents = await fsprReadFile(gcTarget);

        return { name: `${state.projectId}-${state.side}`, contents: contents.toString() };
    }


    checkProjectFile(gbrJobFileName) {
        let project = new PCBProject(gbrJobFileName);
        let projId = project.projectId;
        if (projId) {
            // See if we have this project in the cache already...
            let existingProject = this.projectCache[projId];
            if (existingProject) {
                // This is a pre-existing project. Just
                // update the gbrjob data...
                let newGbrjob = project.gbrjob;
                existingProject.gbrjob = newGbrjob;
                project = existingProject;
            }
            else {
                // A new project altogether
                this.projectCache[projId] = project;
            }

            this.updateFileMap(project);
        }
    }


    // Add all of the files in the project to the file
    // translation table...
    updateFileMap(project, drillWasUpdated) {
        let thiz = this;
        let modified = false;
        project.fileList.forEach(file => {
            if (!thiz.filesToProject.hasOwnProperty(file)) {
               thiz.filesToProject[file] = project;
               modified = true;
            }
        });

        if (modified || drillWasUpdated) {
            let uiObj = project.getUiObj();
            thiz.ipcSend('ui-project-update', uiObj);

            if (project.projectId === _currentProject.projectId) {
                // Time to re-create the project work files...
                _currentProject = {};
            }
        }
    }


    checkGerberFile(gbrFileName) {
        let baseName = path.basename(gbrFileName);
        if (!this.filesToProject[baseName]) {
            // We do not yet have this file as
            // part of a project. Create a
            // psuedo project for it...
            let project = new PCBProject();
            project.fromGerber(gbrFileName);
            let projId = project.projectId;
            if (projId) {
                // This is a legit gerber file as a
                // projectId was determined...
                let existingProject = this.projectCache[projId];
                let drillWasUpdated = false;
                if (existingProject) {
                    // We already have an entry for this.
                    // merge the two...
                    if (!project.drillFile) {
                        let fattr = project.gbrjob.FilesAttributes;
                        if (fattr.length == 1) {
                            existingProject.addFilesAttributes(fattr[0]);
                        }
                    }
                    else if (!existingProject.drillFile) {
                        existingProject.drillFile = project.drillFile;
                        drillWasUpdated = true;
                    }
                    project = existingProject;
                }
                else {
                    this.projectCache[projId] = project;
                }

                this.updateFileMap(project, drillWasUpdated);
            }
        }
    }

    refreshFileList() {
      let thiz = this;
      fse.readdir(dropDir, (err, files) => {
          let msLastSync = this.lastFileSyncMs;
          let jobList = [];
          let gbrList = [];
          files.forEach(file => {
            let fileName = dropDir + file;
            let fstat = fse.statSync(fileName, false);
            if (fstat.mtimeMs > msLastSync) {
                let ext = path.extname(fileName);
                if (ext === '.gbrjob') {
                    jobList.push(fileName);
                }
                else {
                    gbrList.push(fileName);
                }
            }
          });

          jobList.forEach(file => {
             thiz.checkProjectFile(file);
          });

          gbrList.forEach(file => {
            thiz.checkGerberFile(file);
          });

          this.lastFileSyncMs = Date.now();
      });  
    }     
}

ProjectLoader.workDir = workDir;

module.exports = ProjectLoader;
