
"use strict"
import { RPCClient } from './RPCClient.js'
import { RenderMQ } from './RenderMQ.js'
const { untilTrue } = require('promise-utils');
const { deskew } = require('deskew')


const CANVAS_ID = 'uv-mask';
const DIV_INSTRUCTIONS_ID = 'align-instructions';

const CANVAS_SAVE_WIDTH = 24;

const CANVAS_BG_COLOR = '#FFF8DC';
const CANVAS_TRACE_COLOR = '#DEB887';
const CANVAS_HOLE_COLOR = 'black';


const CURSOR_SIZE = 60

/**
 * A class that represents the canvas covering the exposure mask LCD.
 * It is used to render the uv masks, as well as render UI elements
 * used in masking.
 */
class ExposureCanvas extends RPCClient {

    constructor() {

        super('ExposureCanvas')

        this.pcbInfo = { url: null};

        const Config = window.appConfig;
        this.canvas = document.getElementById(CANVAS_ID);
        this.canvas.width = Config.window.width - Config.ui.width;

        if (!Config.window.debug) {
           this.canvas.height = Config.window.height;
        }
        else {
           // Make the canvas smaller for debugging purposes...
           this.canvas.height = 445;
        }

        let thiz = this;

        window.addEventListener('resize', () => {
           thiz.drawingPreCalc();
           thiz.paint();
        });

        this.cursor = { location: { x: 0, y: 0 }, active: false, point: null, color: 'white'}

        this.throttle = { x: Date.now(), y: Date.now() }

        this.drawingPreCalc();
        this.reset();

        RenderMQ.on('global.joystick.stick', (stick) => {
            this.onJoystick(stick);
        });
    }


    /**
     * Return TRUE if this canvas is actually visible at the moment
     */
    isVisible() {
        return (this.canvas.offsetParent !== null)
    }


    async getPcbLocation(mmStart = { x: 0, y: 0}, anchorPoint = { x: 0, y: 0 }) {
        let pxStart = this.toCanvas(mmStart);
        let pxLocation = await this.getPixelLocation(pxStart, anchorPoint)
        let pcbCoord = this.toPCB(pxLocation);
        return pcbCoord;
    }


    async getPixelLocation(pxStart = { x: 0, y: 0}, anchorPoint = { x: 0, y: 0 }) {
        await this.rpCall('uv.safelight', true);
        this.cursor.location = pxStart
        this.activateCursor(true, anchorPoint);
        await untilTrue(500, () => { return (this.cursor.active === false )}, () => { return false; });
        this.activateCursor(false);
        await this.rpCall('uv.safelight', false);
        return this.cursor.location
    }


    /**
     * 
     * There are two coordinate systems at play:
     * The PCB coordinates are in millimeters 
     * and have origin (0,0) at the board's lower left 
     * hand corner.
     *    The UI display coordiante system is in 
     * "canvas coordinates" which are in pixels. The 2D
     * drawing context is modified via setTransform()
     * so pixel (0,0) is also in the lower left hand
     * corner, with X+ to the right and Y+ moving up.
     * The main job of this class is to render 
     * the SVG image of the PCB traces in such as to 
     * match exactly the PCB size in the real world
     * This requires translation to/from PCB and Canvas
     * coordinates.
     * The methods toCanvas() and toPCB() translate back and
     * forth between these two coordinate systems.
     * This method pre-calculates certain values used
     * in those calculations.
    */
    drawingPreCalc() {

        if (!this.isVisible()) {
            console.log('ExposureCanvas drawingPreCalc() called before canvas visible. Try again in 200ms...')
            setTimeout(() => { this.drawingPreCalc()}, 200)
            return;
        }

        let cw = this.canvas.width;
        let ch = this.canvas.height;

        const Config = window.appConfig;

        // Calculate some basic info.  Since
        // the display is rotated, the mask's
        // width and height are reversed from
        // the canvas size.
        this.pxMaskWidth = ch;
        this.pxMaskHeight = cw;
        
        this.ppNavX = Math.round(Config.mask.ppmmWidth / 2);
        this.ppNavY = Math.round(Config.mask.ppmmHeight / 2);

        if (Config.window.debug) {
                // For debugging - use mouse to check coordinates...
           let thiz = this;
           $(`#${CANVAS_ID}`).on('click', function (e) {
                let clientCoord = {};
                var elm = $(this);
                clientCoord.x = e.pageX - elm.offset().left;
                clientCoord.y = e.pageY - elm.offset().top;
                // console.log('clientCoord', clientCoord);
                console.log('canvasCoord', thiz.clientToCanvas(clientCoord))
           })
        }
    }



    getContext() {
        const ctx = this.canvas.getContext('2d');
        this.setTransform(ctx);
        ctx.imageSmoothingEnabled = false;        
        return ctx;
    }

    // JSFiddle for experimenting with transforms:
    // https://jsfiddle.net/joelkoz/4gfbczk2/

    // Sets the transformation matrix for the UI display.
    setTransform(ctx) {

        ctx.resetTransform();

        // Origin at UL of screen. Y axis left to right,
        // X axis up/down. Thus, when monitor is flipped and
        // rotated on the exposure table, we have origin in
        // LL with x positive to right and Y positive up.
        ctx.translate(this.canvas.width, 0)
        ctx.rotate(90 * Math.PI / 180);
        // ctx.scale(1, -1)

        if (this.deskew) {
            // Apply additional deskew transformation as this
            // must be a repaint...
            ctx.rotate(2*Math.PI + this.deskew.rotation);
            ctx.translate(this.deskew.offset.x* this.pxpmm, this.deskew.offset.y* this.pxpmm);
        }        
    
    }


   paint() {
      const canvas = this.canvas;
   
      // This is a hack to force a full screen repaint...
      canvas.width = canvas.width;

      const ctx = this.getContext();
      ctx.fillStyle = this.canvasBtColor;
      ctx.fillRect(0, 0, canvas.pxMaskWidth, canvas.pxMaskHeight);

      if (this.pcbInfo.img == null) {
         return;
      }

      let pc = this.pcbInfo;
      ctx.save();

      ctx.fillStyle = this.pcbInfo.profile.mask.bgColor;
      ctx.fillRect(pc.pxBoardOrigin.x, pc.pxBoardOrigin.y, pc.pxBoardWidth, pc.pxBoardHeight);
      ctx.drawImage(this.pcbInfo.img, pc.pxCopperOrigin.x, pc.pxCopperOrigin.y, pc.pxCopperWidth, pc.pxCopperHeight);
      ctx.restore();
   }

   

   reset(canvasBgColor = 'black') {
        if (this.pcbInfo.url != null) {
           URL.revokeObjectURL(this.pcbInfo.url);
        }
        this.pcbInfo = { url: null };

        // Reset the canvas...
        // this.canvas.style.backgroundColor = canvasBgColor;
        this.canvasBgColor = canvasBgColor;
        const ctx = this.getContext();
        ctx.fillStyle = this.canvasBgColor;
        ctx.fillRect(0, 0, this.pxMaskWidth, this.pxMaskHeight);
   }

   
   setSVG(renderObj) {
      const Config = window.appConfig;

      this.reset();
      this.pcbInfo.profile = renderObj.profile;
      let pcb = this.pcbInfo;

      // Calculate board size based on stock specifications
      // in the profile...
      let stock = renderObj.profile.stock;
      if (stock.actual) {
          stock = stock.actual;
      }
      pcb.pxBoardWidth = stock.width * Config.mask.ppmmWidth;
      pcb.pxBoardHeight = stock.height * Config.mask.ppmmHeight;
      pcb.pxBoardOrigin = {
          x: Config.mask.area.pxUR.x - pcb.pxBoardWidth,
          y: 0
      };
      if (pcb.profile.state.side === 'bottom') {
          // Bottom side traces are rendered offset from the top/Y margin
          pcb.pxBoardOrigin.y = Config.mask.area.pxUR.y - pcb.pxBoardHeight;
      }


      // Now, prepare to load the SVG into the image...
      pcb.url = URL.createObjectURL(new Blob([renderObj.svg], { type: 'image/svg+xml' }));
      pcb.viewBox = renderObj.viewBox;
   
      let thiz = this;
      pcb.img = new Image();
      pcb.img.onload = function() {

         // The image width and height as pre-determined by pixel width as a default...
         pcb.pxCopperWidth = this.naturalWidth;
         pcb.pxCopperHeight = this.naturalHeight;
   
         // What are the multipliers for the view box width and height?
         let mw = renderObj.viewBox[2] / renderObj.width;
         let mh = renderObj.viewBox[3] / renderObj.height;

         // Convert view box offsets to their natural numbers...
         let marginX = renderObj.viewBox[0] / mw;
         let marginY = renderObj.viewBox[1] / mh;
         if (renderObj.units) {
            switch (renderObj.units) {
   
               case 'mm':
                  console.log('SVG size specified in mm');
                  pcb.pxCopperWidth = renderObj.width * Config.mask.ppmmWidth;
                  pcb.pxCopperHeight = renderObj.height * Config.mask.ppmmHeight;
                  pcb.pxMarginX = marginX * Config.mask.ppmmWidth;
                  pcb.pxMarginY = marginY * Config.mask.ppmmHeight;
                  break;
   
               case 'cm':
                  console.log('SVG size specified in cm');
                  pcb.pxCopperWidth = renderObj.width * Config.mask.ppmmWidth * 10.0;
                  pcb.pxCopperHeight = renderObj.height * Config.mask.ppmmHeight * 10.0;
                  pcb.pxMarginX = marginX * Config.mask.ppmmWidth * 10.0;
                  pcb.pxMarginY = marginY * Config.mask.ppmmHeight * 10.0;
                  break;
      
               case 'in':
                  console.log('SVG size specified in inches');
                  pcb.pxCopperWidth = renderObj.width * Config.mask.ppinWidth;
                  pcb.pxCopperHeight = renderObj.height * Config.mask.ppinHeight;
                  pcb.pxMarginX = marginX * Config.mask.ppinWidth;
                  pcb.pxMarginY = marginY * Config.mask.ppinHeight;
                  break;
      
            }

            // Final bounding box calculations based on above copper sizes..
            pcb.pxCopperOrigin = {
                x: pcb.pxBoardOrigin.x + pcb.pxMarginX,
                y: pcb.pxBoardOrigin.y + pcb.pxMarginY
            }

         }
   
         thiz.paint();
   
         // A second refresh seems to be needed on Rapsberry Pi...
         setTimeout(() => { thiz.paint(); }, 10);
   
         console.log('pcbInfo: ', pcb)
      }   
   
      pcb.img.src = pcb.url;
   }


    _getCursorBox(point) {
        let pxLL = Object.assign({}, point);
        let pxUR = Object.assign({}, this.cursor.anchor);
        let width = pxUR.x - pxLL.x;
        if (width < 0) {
            pxLL.x = pxUR.x;
            pxUR.x = point.x;
            width = -width;
        }

        let height = pxUR.y - pxLL.y;
        if (height < 0) {
            pxLL.y = pxUR.y;
            pxUR.y = point.y;
            height = -height;
        }

        return { pxLL, pxUR, width, height }
    }

    // Draws the location cursor at the current location. If the cursor
    // is already displayed, it is moved to the new location.
    drawCursor(cursorOn) {

        if (cursorOn) {

            if (this.cursor.savePoint) {
                // There is an active cursor box drawn...
                if (this.cursor.savePoint.x === this.cursor.location.x &&
                    this.cursor.savePoint.y === this.cursor.location.y) {
                    // Cursor is already on, and nothing has changed, so do
                    // nothing...
                    return;
                }

                // Restore the old image...
                this.drawCursor(false);
            }


            // Calculate where to draw the "cursor box"
            let csrBox = this._getCursorBox(this.cursor.location);

            // Invert the area that is the cursor box...
            let ctx = this.getContext()
            ctx.save();
            ctx.globalCompositeOperation='difference';
            ctx.fillStyle='white';
            ctx.fillRect(csrBox.pxLL.x, csrBox.pxLL.y, csrBox.width, csrBox.height);
            ctx.restore();        

            // Save this info so we can restore the cursor...
            this.cursor.savePoint = Object.assign({}, this.cursor.location);
            this.cursor.saveBox = csrBox;
        }
        else {
            if (this.cursor.savePoint) {
                // Restore the original image by inverting
                // again
                let csrBox = this.cursor.saveBox;
                let ctx = this.getContext()
                ctx.save();
                ctx.globalCompositeOperation='difference';
                ctx.fillStyle='white';
                ctx.fillRect(csrBox.pxLL.x, csrBox.pxLL.y, csrBox.width, csrBox.height);
                ctx.restore();        
                this.cursor.savePoint = null;
            }
        }
    }



    activateCursor(cursorOn = true, anchorPoint = { x: 0, y: 0 }) {
        this.cursor.anchor = anchorPoint;
        this.cursor.active = cursorOn;
        if (cursorOn) {
            if (!this.navCheckInterval) {
                this.navCheckInterval = setInterval(() => { this.onNavigateCheck(); }, 100);
            }
            this.drawCursor(true)
        }
        else {
            if (this.navCheckInterval) {
                clearInterval(this.navCheckInterval);
                delete this.navCheckInterval;
                this.drawCursor(false);
            }
        }
    }


    deflectionToInterval(deflection) {
        const Config = window.appConfig;

        if (deflection < 0.05) {
            return 9999999;
        }
        else if (deflection > 0.95) {
            this.ppNavX = Config.mask.ppmmWidth * 5;
            this.ppNavY = Config.mask.ppmmHeight * 5;
            return 1;
        }
        else if (deflection > 0.35) {
            this.ppNavX = Math.round(Config.mask.ppmmWidth / 2);
            this.ppNavY = Math.round(Config.mask.ppmmHeight / 2);
            return 200;
        }
        else {
            this.ppNavX = Math.round(Config.mask.ppmmWidth / 2);
            this.ppNavY = Math.round(Config.mask.ppmmHeight / 2);
            return 600;
        }
    }


    onJoystick(stick) {
        this.joystick = stick;
    }


    onNavigateCheck() {
        if (this.cursor.active) {
            let stick = this.joystick;

            if (Math.abs(stick.x) > Math.abs(stick.y))
            {
                let dir = Math.sign(stick.x);
                let deflection = Math.abs(stick.x);
                let minInterval = this.deflectionToInterval(deflection);
                let interval = Date.now() - this.throttle.x;
                if (interval > minInterval) {
                    let moveX = dir * this.ppNavX;
                    this.cursor.location.x = Math.round(this.cursor.location.x + moveX);
                    this.throttle.x = Date.now();
                    if (this.cursor.location.x < 0) {
                        this.cursor.location.x = 0;
                    }
                    else if (this.cursor.location.x > this.pxMaskWidth) {
                        this.cursor.location.x = this.pxMaskWidth;
                    }
                    this.drawPending = true;;
                }
            }
            else {
                let dir = Math.sign(stick.y)
                let deflection = Math.abs(stick.y);
                let minInterval = this.deflectionToInterval(deflection);
                let interval = Date.now() - this.throttle.y;
                if (interval > minInterval) {
                    let moveY = dir * this.ppNavY;
                    this.cursor.location.y = Math.round(this.cursor.location.y + moveY);
                    this.throttle.y = Date.now();
                    if (this.cursor.location.y < 0) {
                        this.cursor.location.y = 0;
                    }
                    else if (this.cursor.location.y > this.pxMaskHeight) {
                        this.cursor.location.y = this.pxMaskHeight;
                    }
                    this.drawPending = true;
                }
            }
            if (this.drawPending) {
                this.drawCursor(true, this.cursor.color);
                this.drawPending = false;
            }
        }
    }


    // Translate PCB coordinates to UI display canvas coordinates
    toCanvas(pcbCoord) {
        const Config = window.appConfig;

        let pxMarginX = 0;
        let pxMarginY = 0;
        let pcb = this.pcbInfo;
        if (pcb.pxBoardOrigin) {
            pxMarginX = pcb.pxBoardOrigin.x;
            pxMarginY = pcb.pxBoardOrigin.y;
        }

        return {
            x: Math.round(pcbCoord.x * Config.mask.ppmmWidth + pxMarginX),
            y: Math.round(pcbCoord.y * Config.mask.ppmmHeight + pxMarginY)
        };
    }


    // Translate canvas coordinates back to PCB coordinates
    toPCB(canvasCoord) {
        const Config = window.appConfig;

        let pxMarginX = 0;
        let pxMarginY = 0;
        let pcb = this.pcbInfo;
        if (pcb.pxBoardOrigin) {
            pxMarginX = pcb.pxBoardOrigin.x;
            pxMarginY = pcb.pxBoardOrigin.y;
        }

        let x = (canvasCoord.x - pxMarginX) / Config.mask.ppmmWidth;
        let y = (canvasCoord.y - pxMarginY) / Config.mask.ppmmHeight;

        return {
            "x": x,
            "y": y
        }
    }


    // Translate client coordinates (i.e. pixel coordinates like client position)
    // to canvas coordinates.
    clientToCanvas(clientCoord) {
        const ctx = this.getContext();
        let matrix = ctx.getTransform();
        var imatrix = matrix.invertSelf();
        let x = clientCoord.x * imatrix.a + clientCoord.y * imatrix.c + imatrix.e;
        let y = clientCoord.x * imatrix.b + clientCoord.y * imatrix.d + imatrix.f;
        return { x, y };
    }


    // Translate canvas coordinates to client pixel coordinates
    canvasToClient(canvasCoord) {
        const ctx = this.getContext();
        let matrix = ctx.getTransform();
        let x = canvasCoord.x * matrix.a + canvasCoord.y * matrix.c + matrix.e;
        let y = canvasCoord.x * matrix.b + canvasCoord.y * matrix.d + matrix.f;
        return { x: Math.round(x), y: Math.round(y) };
    }

}


export { ExposureCanvas }
