import * as fabric from 'fabric';

/**
 * Wait for an object to be fully loaded and initialized
 */
export const initFabricCanvas = (canvasElement: HTMLCanvasElement): fabric.Canvas => {
  const canvas = new fabric.Canvas(canvasElement, {
    selection: false,
    preserveObjectStacking: true,
  });
  return canvas;
};

export const applyToolState = (canvas: fabric.Canvas, tool: string) => {
  canvas.isDrawingMode = false;
  canvas.selection = tool === 'select';
  
  canvas.forEachObject((obj) => {
    obj.selectable = tool === 'select';
    obj.evented = tool === 'select' || tool === 'pan';
  });

  if (tool === 'pan') {
    canvas.defaultCursor = 'grab';
  } else if (['measure-distance', 'measure-area', 'set-scale'].includes(tool)) {
    canvas.defaultCursor = 'crosshair';
  } else if (tool === 'text' || tool === 'note') {
    canvas.defaultCursor = 'text';
  } else {
    canvas.defaultCursor = 'default';
  }
};

export const generateId = () => crypto.randomUUID();
