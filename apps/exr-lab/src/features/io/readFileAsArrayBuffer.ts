export const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> =>
  new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      const result = event.target?.result;
      if (result instanceof ArrayBuffer) {
        resolve(result);
        return;
      }

      reject(new Error(`Failed to read "${file.name}".`));
    };

    reader.onerror = () => {
      reject(reader.error ?? new Error(`Failed to read "${file.name}".`));
    };

    reader.readAsArrayBuffer(file);
  });
