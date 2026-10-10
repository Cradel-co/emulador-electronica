El firmware cacheado se verifica antes de usarlo y las descargas de módulos y firmware se cancelan al superar su límite durante la lectura.

La caché histórica sin huella requiere retirar el binario y descargarlo de nuevo. Una huella
conservada no se reemplaza ante corrupción; la primera descarga fija una referencia TOFU,
sin autenticar su origen. Los límites se aplican incluso sin Content-Length.
