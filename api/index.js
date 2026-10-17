const path = require('path');
const express = require('express');
const sql = require('mssql');
require('dotenv').config();

const app = express();
const projectRoot = path.join(__dirname, '..');
let poolPromise;

app.use(express.json({ limit: '10kb' }));

const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

function getPool() {
  if (!poolPromise) {
    const requiredVariables = ['DB_SERVER', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
    const missingVariables = requiredVariables.filter((name) => !process.env[name]);

    if (missingVariables.length > 0) {
      throw new Error(`Faltan variables de entorno: ${missingVariables.join(', ')}`);
    }

    const config = {
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      server: process.env.DB_SERVER,
      port: Number.parseInt(process.env.DB_PORT || '1433', 10),
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
      },
      options: {
        encrypt: true,
        trustServerCertificate: false
      },
      connectionTimeout: 30000
    };

    poolPromise = new sql.ConnectionPool(config).connect().catch((error) => {
      poolPromise = null;
      throw error;
    });
  }

  return poolPromise;
}

function validateContact(body) {
  const fields = ['nombre', 'email', 'telefono'];
  const values = {};

  for (const field of fields) {
    if (typeof body[field] !== 'string' || !body[field].trim()) {
      return { error: `El campo "${field}" es obligatorio.` };
    }
    values[field] = body[field].trim();
  }

  if (values.nombre.length > 100) {
    return { error: 'El nombre no puede superar los 100 caracteres.' };
  }
  if (values.email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    return { error: 'Ingresa un correo electrónico válido de hasta 100 caracteres.' };
  }
  if (values.telefono.length > 20 || !/^[+\d\s().-]+$/.test(values.telefono)) {
    return { error: 'Ingresa un teléfono válido de hasta 20 caracteres.' };
  }

  return { values };
}

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

app.get('/', (req, res) => {
  res.sendFile(path.join(projectRoot, 'index.html'));
});

app.get('/api/health', asyncHandler(async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(
    'SELECT 1 AS conectado, GETDATE() AS fechaServidor'
  );

  res.json({
    status: 'conectado',
    mensaje: 'Conexión a Azure SQL establecida con éxito',
    servidor: process.env.DB_SERVER,
    baseDatos: process.env.DB_NAME,
    fechaServidor: result.recordset[0].fechaServidor
  });
}));

app.get('/api/contactos', asyncHandler(async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(
    'SELECT Id, Nombre, Email, Telefono FROM Contactos ORDER BY Id DESC'
  );
  res.json(result.recordset);
}));

app.get('/api/contactos/:id', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'El ID debe ser un entero positivo.' });
  }

  const pool = await getPool();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(
      'SELECT Id, Nombre, Email, Telefono FROM Contactos WHERE Id = @id'
    );

  if (result.recordset.length === 0) {
    return res.status(404).json({ error: 'No se encontró el contacto.' });
  }
  return res.json(result.recordset[0]);
}));

app.post('/api/contactos', asyncHandler(async (req, res) => {
  const { values, error } = validateContact(req.body || {});
  if (error) {
    return res.status(400).json({ error });
  }

  const pool = await getPool();
  const result = await pool.request()
    .input('nombre', sql.NVarChar(100), values.nombre)
    .input('email', sql.NVarChar(100), values.email)
    .input('telefono', sql.NVarChar(20), values.telefono)
    .query(`
      INSERT INTO Contactos (Nombre, Email, Telefono)
      OUTPUT INSERTED.Id, INSERTED.Nombre, INSERTED.Email, INSERTED.Telefono
      VALUES (@nombre, @email, @telefono)
    `);

  return res.status(201).json(result.recordset[0]);
}));

app.put('/api/contactos/:id', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'El ID debe ser un entero positivo.' });
  }

  const { values, error } = validateContact(req.body || {});
  if (error) {
    return res.status(400).json({ error });
  }

  const pool = await getPool();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .input('nombre', sql.NVarChar(100), values.nombre)
    .input('email', sql.NVarChar(100), values.email)
    .input('telefono', sql.NVarChar(20), values.telefono)
    .query(`
      UPDATE Contactos
      SET Nombre = @nombre, Email = @email, Telefono = @telefono
      OUTPUT INSERTED.Id, INSERTED.Nombre, INSERTED.Email, INSERTED.Telefono
      WHERE Id = @id
    `);

  if (result.recordset.length === 0) {
    return res.status(404).json({ error: 'No se encontró el contacto.' });
  }
  return res.json(result.recordset[0]);
}));

app.delete('/api/contactos/:id', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'El ID debe ser un entero positivo.' });
  }

  const pool = await getPool();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query('DELETE FROM Contactos WHERE Id = @id');

  if (result.rowsAffected[0] === 0) {
    return res.status(404).json({ error: 'No se encontró el contacto.' });
  }
  return res.status(204).end();
}));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Ruta de API no encontrada.' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'El cuerpo de la solicitud no contiene JSON válido.' });
  }

  console.error('Error al procesar la solicitud:', error);
  return res.status(500).json({ error: 'No se pudo completar la solicitud.' });
});

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || '3000', 10);
  app.listen(port, () => {
    console.log(`Directorio de contactos disponible en http://localhost:${port}`);
  });
}

module.exports = app;
