// ===================================================================================
// OTOMATISASI GOOGLE EARTH ENGINE UNTUK PENDETEKSIAN POTENSI PANAS BUMI
//(Farrel Nugroho_117210005_UPN "Veteran" Yogyakarta)
// Metode: Ambang Batas Tetap (Regional) dengan Grafik Tren Tahunan
// Deskripsi: Skrip ini mengidentifikasi anomali suhu dengan menghitung LST rata-rata
//            jangka panjang, kemudian menetapkan ambang batas anomali berdasarkan
//            rata-rata dan standar deviasi regional. Potensi dinilai dengan
//            menggabungkan anomali suhu dan kedekatan dengan zona patahan.
//            Skrip ini juga menampilkan grafik tren LST tahunan untuk analisis temporal.
// ===================================================================================


// ===================================================================================
// === BAGIAN 1: PARAMETER YANG DAPAT DIUBAH (DISESUAIKAN DENGAN DATA USER) ===
// ===================================================================================

// 1.1: Wilayah Studi & Data Geologi (Ubah sesuai path GEE Asset Anda)
var regionOfInterest = ee.FeatureCollection('projects/ee-farrelrafigame/assets/shp_jawabarat');
var faultData = ee.FeatureCollection('projects/ee-farrelrafigame/assets/patahan_jabar');
var wkpData = ee.FeatureCollection('projects/ee-farrelrafigame/assets/wkp_jabar'); // Opsional, untuk validasi

// 1.2: Parameter Analisis Data
var startDate = '2017-01-01';
var endDate = '2023-12-31';
var seasonFilter = ee.Filter.calendarRange(10, 4, 'month'); // Musim Hujan (Bulan 10-4)
var cloudCoverThreshold = 10; // Maksimum persentase tutupan awan

// 1.3: Parameter Skoring & Anomali
var faultBufferDistance = 1000; // Jarak buffer dari patahan dalam meter (untuk Skor 2)

// 1.4: Atur ambang batas anomali berdasarkan kelipatan standar deviasi (σ)
var weakAnomalyMultiplier = 1.5;   // Anomali Lemah > µ + 1.5σ
var mediumAnomalyMultiplier = 2.0; // Anomali Sedang > µ + 2.0σ
var strongAnomalyMultiplier = 2.5; // Anomali Kuat   > µ + 2.5σ


// ===================================================================================
// === BAGIAN 2: PENYIAPAN PETA DAN VISUALISASI AWAL ===
// ===================================================================================

Map.centerObject(regionOfInterest, 10);
Map.addLayer(regionOfInterest, {color: 'gray', fillColor: 'rgba(128, 128, 128, 0.1)'}, 'Wilayah Studi');
Map.addLayer(faultData, {color: 'red'}, 'Zona Patahan', false);
Map.addLayer(wkpData, {color: 'black'}, 'WKP Panas Bumi', false);

// 2.1: Impor dan Visualisasi Aset TIF Tambahan (Hanya sebagai validasi dengan penelitian terdahulu Saepuloh et al.)
var image1 = ee.Image("projects/ee-farrelrafigame/assets/1");
var image2 = ee.Image("projects/ee-farrelrafigame/assets/2");
var image3 = ee.Image("projects/ee-farrelrafigame/assets/3");

// Definisikan parameter visualisasi untuk citra TIF
var tifVisParams = {
  min: 0,
  max: 255,
};

// Tambahkan citra TIF ke peta
Map.addLayer(image1, tifVisParams, 'Visualisasi TIF 1');
Map.addLayer(image2, tifVisParams, 'Visualisasi TIF 2');
Map.addLayer(image3, tifVisParams, 'Visualisasi TIF 3');


// ===================================================================================
// === BAGIAN 3: FUNGSI-FUNGSI UTAMA UNTUK PEMROSESAN CITRA ===
// ===================================================================================

// Fungsi 3.1: Persiapan Citra Landsat 8 (Scaling & Cloud Masking)
function prepareL8(image) {
  var optical = image.select('SR_B[2-7]').multiply(0.0000275).add(-0.2);
  var thermal = image.select('ST_B10').multiply(0.00341802).add(149.0);
  
  var qa = image.select('QA_PIXEL');
  var cloud = (1 << 3);
  var cloudShadow = (1 << 4);
  var mask = qa.bitwiseAnd(cloud).eq(0).and(qa.bitwiseAnd(cloudShadow).eq(0));
  
  var ndvi = image.normalizedDifference(['SR_B5','SR_B4']).rename('NDVI');
  
  return image.addBands(optical, null, true)
    .addBands(thermal, null, true)
    .addBands(ndvi)
    .updateMask(mask);
}

// Fungsi 3.2: Masking Badan Air menggunakan MNDWI
function maskWater(image) {
  var mndwi = image.normalizedDifference(['SR_B3', 'SR_B6']).rename('MNDWI');
  var waterMask = mndwi.lt(-0.25); //(bisa disesuaikan dengan lokasi studi untuk masking badan air yang lebih sempurna)
  return image.updateMask(waterMask);
}

// Fungsi 3.3: Masking Area Perkotaan menggunakan Copernicus Landcover 
function maskUrban(image) {
  var copernicusLC = ee.ImageCollection('COPERNICUS/Landcover/100m/Proba-V-C3/Global')
                        .filterDate('2019-01-01', '2019-12-31')
                        .select('discrete_classification')
                        .first();
  var urbanClass = 50;
  var urbanMask = copernicusLC.neq(urbanClass);
  return image.updateMask(urbanMask);
}

// Fungsi 3.4: Perhitungan LST menggunakan Mono-Window Algorithm 
function calculateLST(image) {
  var ndvi = image.select('NDVI');
  var ndviStats = image.select('NDVI').reduceRegion({
    reducer: ee.Reducer.minMax(),
    geometry: regionOfInterest,
    scale: 30,
    maxPixels: 1e9
  });
  
  var ndviMin = ee.Number(ndviStats.get('NDVI_min'));
  var ndviMax = ee.Number(ndviStats.get('NDVI_max'));

  var pv = ndvi.subtract(ndviMin).divide(ndviMax.subtract(ndviMin)).pow(2).rename('PV');
  var emissivity = pv.multiply(0.004).add(0.986).rename('EM');
  
  var LST = image.expression(
    'TB / (1 + (10.895e-6 * TB / 1.438e-2) * log(EM)) - 273.15', {
      'TB': image.select('ST_B10'),
      'EM': emissivity
    }
  ).rename('LST');
  
  return image.addBands([pv, emissivity, LST]);
}

// Fungsi 3.5: Koreksi Elevasi pada LST
function correctElevation(image, dem, slope, referenceElev) {
    var corrected_lst = image.expression(
    'LST - (slope * (elev - ref_elev))', {
      'LST': image.select('LST'),
      'slope': slope,
      'ref_elev': referenceElev,
      'elev': dem
    }
  ).rename('LST_corrected');
  return image.addBands(corrected_lst);
}

// ===================================================================================
// === BAGIAN 4: PEMROSESAN DATA UTAMA & PERHITUNGAN LST ===
// ===================================================================================

// 4.1: Impor dan Filter Koleksi Citra Landsat 8
var l8Collection = ee.ImageCollection("LANDSAT/LC08/C02/T1_L2")
  .filterDate(startDate, endDate)
  .filterBounds(regionOfInterest)
  .filter(seasonFilter)
  .filter(ee.Filter.lt('CLOUD_COVER', cloudCoverThreshold))
  .filter(ee.Filter.eq('PROCESSING_LEVEL', 'L2SP'))
  .map(prepareL8);

// 4.2: Terapkan Fungsi Masking dan Perhitungan LST 
var l8Processed = l8Collection
  .map(maskWater)
  .map(maskUrban)
  .map(calculateLST);

// 4.3: Lakukan Koreksi Elevasi 
var dem = ee.Image("USGS/SRTMGL1_003").select('elevation');
var meanLstForRegression = l8Processed.select('LST').mean().clip(regionOfInterest);
var regressionData = dem.addBands(meanLstForRegression);

var linearFit = regressionData.reduceRegion({
  reducer: ee.Reducer.linearFit(),
  geometry: regionOfInterest,
  scale: 30,
  maxPixels: 1e9
});

var slope = ee.Number(linearFit.get('scale'));
var referenceElev = ee.Number(dem.reduceRegion({
  reducer: ee.Reducer.median(),
  geometry: regionOfInterest,
  scale: 30,
  maxPixels: 1e9
}).get('elevation'));

var l8Final = l8Processed.map(function(image) {
  return correctElevation(image, dem, slope, referenceElev);
}).select('LST_corrected');

// 4.4: Buat Peta LST Rata-Rata Final 
var meanLST = l8Final.mean().clip(regionOfInterest);

//  4.5: Buat Koleksi Data Rata-rata Tahunan (Untuk Grafik) 
var years = ee.List.sequence(ee.Number.parse(startDate.slice(0,4)), ee.Number.parse(endDate.slice(0,4)));

var annualLSTCollection = ee.ImageCollection.fromImages(
  years.map(function(year) {
    var annualCollection = l8Final.filter(ee.Filter.calendarRange(year, year, 'year'));
    return annualCollection.mean()
      .set('year', year)
      .set('system:time_start', ee.Date.fromYMD(year, 1, 1));
  })
);

// ===================================================================================
// === BAGIAN 5: DETEKSI ANOMALI & SKORING (Metode Ambang Batas Tetap) ===
// ===================================================================================

// 5.1: Hitung Statistik Regional dari Peta LST Rata-Rata 
var regionalStats = meanLST.reduceRegion({
  reducer: ee.Reducer.mean().combine({reducer2: ee.Reducer.stdDev(), sharedInputs: true}),
  geometry: regionOfInterest,
  scale: 30,
  maxPixels: 1e13
});

var regionalMean = ee.Number(regionalStats.get('LST_corrected_mean'));
var regionalStdDev = ee.Number(regionalStats.get('LST_corrected_stdDev'));

print('--- STATISTIK LST REGIONAL ---');
print('LST Rata-rata (µ):', regionalMean);
print('LST Standar Deviasi (σ):', regionalStdDev);

// 5.2: Tentukan Ambang Batas Anomali
var mainAnomalyThreshold = regionalMean.add(regionalStdDev);
var weakAnomalyThreshold = regionalMean.add(regionalStdDev.multiply(weakAnomalyMultiplier));
var mediumAnomalyThreshold = regionalMean.add(regionalStdDev.multiply(mediumAnomalyMultiplier));
var strongAnomalyThreshold = regionalMean.add(regionalStdDev.multiply(strongAnomalyMultiplier));

// 5.3: Buat Layer Anomali
var baseAnomalyLayer = meanLST.gt(mainAnomalyThreshold);
var weakAnomalyLayer = meanLST.gt(weakAnomalyThreshold).selfMask();
var mediumAnomalyLayer = meanLST.gt(mediumAnomalyThreshold).selfMask();
var strongAnomalyLayer = meanLST.gt(strongAnomalyThreshold).selfMask();

// 5.4: Hitung Skor Potensi
var faultBuffer = faultData.map(function(feature) {
  return feature.buffer(faultBufferDistance);
}).union();
var nearFaultLayer = ee.Image().paint(faultBuffer, 1).unmask(0);
var strongAnomalyBase = meanLST.gt(strongAnomalyThreshold); 
var score1Layer = strongAnomalyBase.selfMask();
var totalScore = strongAnomalyBase.add(nearFaultLayer);
var score2Layer = totalScore.gte(2).selfMask();

// 5.5: Cetak Informasi Penting Ke Console
print('--- INFORMASI UMUM & REGRESI ---');
print('Jumlah citra tersedia setelah filter awal:', l8Collection.size());
print('Lapse Rate Lokal (Slope):', slope, '°C/m');
print('Intercept Regresi:', linearFit.get('offset'), '°C');
print('Elevasi Referensi (Median):', referenceElev, 'm');

print('--- AMBANG BATAS SUHU ANOMALI ---');
print('Ambang Batas Utama (> µ + 1σ):', mainAnomalyThreshold, '°C');
print('Ambang Batas Lemah (> ' + weakAnomalyMultiplier + 'σ):', weakAnomalyThreshold, '°C');
print('Ambang Batas Sedang (> ' + mediumAnomalyMultiplier + 'σ):', mediumAnomalyThreshold, '°C');
print('Ambang Batas Kuat (> ' + strongAnomalyMultiplier + 'σ):', strongAnomalyThreshold, '°C');

// Hitung dan cetak LST Min/Max dari peta rata-rata final
var lstMinMax = meanLST.reduceRegion({
  reducer: ee.Reducer.minMax(),
  geometry: regionOfInterest,
  scale: 30,
  maxPixels: 1e9
});

// Gunakan .evaluate() untuk memastikan nilai dicetak setelah dihitung
lstMinMax.evaluate(function(result, error) {
  if (error) {
    print('Error menghitung Min/Max LST:', error);
  } else {
    print('--- STATISTIK PETA LST RATA-RATA ---');
    print('LST Minimum (°C):', result.LST_corrected_min);
    print('LST Maximum (°C):', result.LST_corrected_max);
  }
});

// ===================================================================================
// === BAGIAN 6: VISUALISASI HASIL AKHIR PADA PETA ===
// ===================================================================================

// 6.1: Parameter Visualisasi 
var lstParams = {min: 20, max: 35, palette: ['040274', '040281', '0502a3', '0502b8', '0502ce', '0502e6', '0602ff', '235cb1', '307ef3', '269db1', '30c8e2', '32d3ef', '3be285', '3ff38f', '86e26f', '3ae237', 'b5e22e', 'd6e21f', 'fff705', 'ffd611', 'ffb613', 'ff8b13', 'ff6e08', 'ff500d', 'ff0000', 'de0101', 'c21301', 'a71001', '911003']};

// 6.2: Tambahkan Layer ke Peta
Map.addLayer(meanLST, lstParams, 'Peta LST Rata-rata');
Map.addLayer(weakAnomalyLayer, {palette: ['yellow']}, 'Anomali Lemah (>'+weakAnomalyMultiplier+'σ)', false);
Map.addLayer(mediumAnomalyLayer, {palette: ['orange']}, 'Anomali Sedang (>'+mediumAnomalyMultiplier+'σ)', false);
Map.addLayer(strongAnomalyLayer, {palette: ['red']}, 'Anomali Kuat (>'+strongAnomalyMultiplier+'σ)', false);
Map.addLayer(faultBuffer, {palette: ['purple'], opacity: 0.5}, 'Buffer Zona Patahan', false);
Map.addLayer(score1Layer, {palette: ['orange']}, 'Skor 1: Hotspot', true);
Map.addLayer(score2Layer, {palette: ['red']}, 'Skor 2: Overlap Hotspot & Patahan', true);


// ===================================================================================
// === BAGIAN 7: GRAFIK STATISTIK TAHUNAN ===
// ===================================================================================

var lstAnnualChart = ui.Chart.image.series({
  imageCollection: annualLSTCollection.select('LST_corrected'),
  region: regionOfInterest,
  reducer: ee.Reducer.mean(),
  scale: 1000,
  xProperty: 'year'
}).setOptions({
  title: 'Rata-rata LST Tahunan di Wilayah Studi',
  vAxis: {title: 'Suhu Permukaan Darat (°C)'},
  hAxis: {title: 'Tahun', format: '####'},
  legend: {position: 'none'},
});

print(lstAnnualChart);