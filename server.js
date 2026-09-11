// server.js
// Backend mínimo que hace de intermediario entre tu web y la Data API de Travelpayouts.
// Así tu token nunca se expone en el navegador del usuario.

import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();

// Solo tu web puede llamar a este backend — protege tu token de que otros lo usen desde su propia página.
app.use(cors({ origin: "https://vuelostravel.netlify.app" }));

const TRAVELPAYOUTS_TOKEN = process.env.TRAVELPAYOUTS_TOKEN;
const MARKER = process.env.TRAVELPAYOUTS_MARKER;

if (!TRAVELPAYOUTS_TOKEN || !MARKER) {
  console.warn(
    "⚠️  Falta TRAVELPAYOUTS_TOKEN o TRAVELPAYOUTS_MARKER en tu archivo .env"
  );
}

// GET /api/vuelos?origin=MAD&destination=BCN&departure_at=2026-10-14&return_at=2026-10-20&direct=false
app.get("/api/vuelos", async (req, res) => {
  const { origin, destination, departure_at, return_at, direct } = req.query;

  if (!origin || !destination) {
    return res.status(400).json({ error: "Faltan origin y/o destination" });
  }

  const params = new URLSearchParams({
    origin,
    destination,
    currency: "eur",
    sorting: "price",
    direct: direct === "true" ? "true" : "false",
    limit: "30",
    page: "1",
    one_way: return_at ? "false" : "true",
    token: TRAVELPAYOUTS_TOKEN,
  });

  if (departure_at) params.append("departure_at", departure_at);
  if (return_at) params.append("return_at", return_at);

  const url = `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?${params.toString()}`;

  try {
    const response = await fetch(url);
    const json = await response.json();

    if (!json.success) {
      return res.status(502).json({ error: "La API de Travelpayouts devolvió un error", detail: json });
    }

    // Añadimos a cada vuelo el enlace de reserva completo, ya con el marker de afiliado.
    const flights = (json.data || []).map((f) => ({
      ...f,
      bookingUrl: `https://www.aviasales.com${f.link}&marker=${MARKER}`,
    }));

    res.json({ flights });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error llamando a Travelpayouts" });
  }
});

// GET /api/explorar-pais?origin=BCN&pais=Tailandia
// Cuando el destino es un país entero, busca las ciudades de ese país
// y las ordena por el precio más barato encontrado desde el origen.
app.get("/api/explorar-pais", async (req, res) => {
  const { origin, pais } = req.query;
  if (!origin || !pais) {
    return res.status(400).json({ error: "Faltan origin y/o pais" });
  }

  try {
    // 1. Ciudades que pertenecen a ese país (vía autocompletado)
    const acParams = new URLSearchParams({ term: pais, locale: "es" });
    acParams.append("types[]", "city");
    const acRes = await fetch(`http://autocomplete.travelpayouts.com/places2?${acParams.toString()}`);
    const acData = await acRes.json();

    const ciudadesDelPais = (acData || []).filter(
      (item) => item.code && item.type === "city" &&
        (item.country_name || "").toLowerCase() === pais.toLowerCase()
    );

    if (ciudadesDelPais.length === 0) {
      return res.json({ destinations: [], message: "No encontramos ciudades para ese país" });
    }

    const codigosPais = new Set(ciudadesDelPais.map((c) => c.code));
    const nombrePorCodigo = Object.fromEntries(ciudadesDelPais.map((c) => [c.code, c.name]));

    // 2. Precios más baratos cacheados desde el origen, a todos los destinos posibles
    const cdParams = new URLSearchParams({ origin, currency: "eur", token: TRAVELPAYOUTS_TOKEN });
    const cdRes = await fetch(`https://api.travelpayouts.com/v1/city-directions?${cdParams.toString()}`);
    const cdJson = await cdRes.json();

    if (!cdJson.success) {
      return res.status(502).json({ error: "La API de Travelpayouts devolvió un error", detail: cdJson });
    }

    // 3. Cruzamos: nos quedamos solo con los destinos que están dentro del país buscado
    const destinos = Object.values(cdJson.data || {})
      .filter((d) => codigosPais.has(d.destination))
      .map((d) => ({
        code: d.destination,
        name: nombrePorCodigo[d.destination] || d.destination,
        price: d.price,
        direct: d.transfers === 0,
      }))
      .sort((a, b) => a.price - b.price)
      .slice(0, 8);

    res.json({ destinations: destinos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error explorando el país" });
  }
});

// GET /api/destacados?origin=BCN
// Los destinos más baratos encontrados recientemente desde un origen, para mostrar en portada.
app.get("/api/destacados", async (req, res) => {
  const { origin } = req.query;
  if (!origin) return res.status(400).json({ error: "Falta origin" });

  try {
    const cdParams = new URLSearchParams({ origin, currency: "eur", token: TRAVELPAYOUTS_TOKEN });
    const cdRes = await fetch(`https://api.travelpayouts.com/v1/city-directions?${cdParams.toString()}`);
    const cdJson = await cdRes.json();

    if (!cdJson.success) {
      return res.status(502).json({ error: "La API de Travelpayouts devolvió un error", detail: cdJson });
    }

    const top = Object.values(cdJson.data || {})
      .sort((a, b) => a.price - b.price)
      .slice(0, 8);

    // Buscamos el nombre de cada ciudad destino (la API de precios solo da códigos IATA).
    const destacados = await Promise.all(
      top.map(async (d) => {
        try {
          const acParams = new URLSearchParams({ term: d.destination, locale: "es" });
          acParams.append("types[]", "city");
          acParams.append("types[]", "airport");
          const acRes = await fetch(`http://autocomplete.travelpayouts.com/places2?${acParams.toString()}`);
          const acData = await acRes.json();
          const match = (acData || []).find((item) => item.code === d.destination);
          return {
            code: d.destination,
            name: match ? (match.cityName || match.name) : d.destination,
            countryName: match ? match.country_name : "",
            price: d.price,
            direct: d.transfers === 0,
          };
        } catch {
          return { code: d.destination, name: d.destination, countryName: "", price: d.price, direct: d.transfers === 0 };
        }
      })
    );

    res.json({ destacados });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al buscar destacados" });
  }
});

// GET /api/calendario?origin=BCN&destination=LIS&mes=2026-10
// Precio más barato encontrado para cada día del mes indicado.
app.get("/api/calendario", async (req, res) => {
  const { origin, destination, mes } = req.query;
  if (!origin || !destination || !mes) {
    return res.status(400).json({ error: "Faltan origin, destination y/o mes" });
  }

  try {
    const params = new URLSearchParams({
      origin,
      destination,
      depart_date: mes,
      calendar_type: "departure_date",
      currency: "eur",
      token: TRAVELPAYOUTS_TOKEN,
    });
    const response = await fetch(`https://api.travelpayouts.com/v1/prices/calendar?${params.toString()}`);
    const json = await response.json();

    if (!json.success) {
      return res.status(502).json({ error: "La API de Travelpayouts devolvió un error", detail: json });
    }

    // La respuesta agrupa por fecha, y dentro por número de escalas (0, 1, 2...).
    // Nos quedamos con el precio más barato disponible para cada día.
    const dias = Object.entries(json.data || {}).map(([fecha, porEscalas]) => {
      const precios = Object.values(porEscalas)
        .map((v) => (v && typeof v === "object" ? v.price : null))
        .filter((p) => typeof p === "number");
      const precioMinimo = precios.length ? Math.min(...precios) : null;
      return { fecha, precio: precioMinimo };
    }).filter((d) => d.precio !== null);

    res.json({ dias });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener el calendario de precios" });
  }
});

const PORT = process.env.PORT || 3001;

// GET /api/autocomplete?term=Barcel
// Sugerencias de ciudades, aeropuertos y países. Esta API de Travelpayouts es pública (no requiere token).
app.get("/api/autocomplete", async (req, res) => {
  const { term } = req.query;
  if (!term || term.length < 2) return res.json({ suggestions: [] });

  const params = new URLSearchParams({ term, locale: "es" });
  params.append("types[]", "city");
  params.append("types[]", "airport");
  params.append("types[]", "country");

  const url = `http://autocomplete.travelpayouts.com/places2?${params.toString()}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    const suggestions = (data || [])
      .filter((item) => item.code) // descarta entradas sin código IATA (p.ej. algunos países)
      .map((item) => ({
        code: item.code,
        name: item.name,
        type: item.type,
        countryName: item.country_name || "",
        cityName: item.city_name || "",
      }));

    res.json({ suggestions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al buscar sugerencias" });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
