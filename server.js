const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Connexion à Neon (PostgreSQL)
const { Pool } = require('pg');

// Pool pour l’écriture (instance principale)
const writePool = new Pool({
  connectionString: process.env.DATABASE_URL_WRITE, // URL de l’instance principale
  ssl: { rejectUnauthorized: false },
});

// Pool pour la lecture (réplique)
const readPool = new Pool({
  connectionString: process.env.DATABASE_URL_READ, // URL de la réplique Neon
  ssl: { rejectUnauthorized: false },
});

// Configuration Cloudinary
cloudinary.config({
  cloud_name: 'dluqdzeml',
  api_key: '982631744688698',
  api_secret: 'obQzDBDjB8qswwwSKJtYbL7f-S4',
});

// Création des tables dans Neon
const createTables = async () => {
  try {
    await writePool.query(`
      CREATE TABLE IF NOT EXISTS cars (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        brand TEXT NOT NULL,
        price REAL NOT NULL,
        available INTEGER NOT NULL,
        image_url TEXT,
        description TEXT,
        acceleration TEXT,
        consumption TEXT,
        puissance TEXT,
        reservations_count INTEGER DEFAULT 0,
        vote INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT,
        reservations_count INTEGER DEFAULT 0,
        total_spent REAL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS reservations (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER NOT NULL,
        car_id INTEGER NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        total REAL NOT NULL,
        status TEXT NOT NULL,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
        FOREIGN KEY (car_id) REFERENCES cars(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY,
        site_name TEXT,
        phone TEXT,
        contact_email TEXT,
        facebook TEXT,
        instagram TEXT,
        adress TEXT,
        gps TEXT,
        maintenance_mode INTEGER
      );
      CREATE TABLE IF NOT EXISTS testimonials (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        rating INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Tables créées avec succès dans Neon.');
  } catch (err) {
    console.error('Erreur lors de la création des tables :', err);
  }
};
createTables();

// Multer pour les uploads d’images
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `temp_${Date.now()}${path.extname(file.originalname)}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif/;
    if (filetypes.test(file.mimetype) && filetypes.test(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Seules les images sont autorisées (jpeg, jpg, png, gif)'));
    }
  },
});

// Root endpoint
app.get('/', (req, res) => {
  res.send('Luxury Drive API (Neon PostgreSQL) is running!');
});

// --- Cars Endpoints ---
// GET /api/cars
app.get('/api/cars', async (req, res) => {
  try {
    const result = await readPool.query('SELECT * FROM cars');
    res.json(result.rows);
  } catch (err) {
    console.error('Erreur lors de la récupération des voitures :', err);
    res.status(500).json({ error: 'Échec de la récupération des voitures' });
  }
});

// POST /api/cars
app.post('/api/cars', upload.single('image'), async (req, res) => {
  const { name, brand, price, available, description, consumption, acceleration, puissance } = req.body;
  if (!name || !brand || !price || available === undefined || !req.file || !description || !consumption || !acceleration || !puissance) {
    return res.status(400).json({ error: 'Tous les champs sont requis, y compris une image' });
  }
  try {
    const result = await cloudinary.uploader.upload(req.file.path, { folder: 'cars' });
    const imagePath = result.secure_url;
    const { rows } = await writePool.query(
      'INSERT INTO cars (name, brand, price, available, image_url, description, acceleration, consumption, puissance) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
      [name, brand, price, available === 'true' ? 1 : 0, imagePath, description, acceleration, consumption, puissance]
    );
    res.status(201).json(rows[0]);
    fs.unlinkSync(req.file.path);
  } catch (err) {
    console.error('Erreur lors de l’ajout de la voiture :', err);
    res.status(500).json({ error: 'Échec de l’ajout de la voiture' });
  }
});

// PUT /api/cars/:id
app.put('/api/cars/:id', upload.single('image'), async (req, res) => {
  const id = req.params.id;
  const { name, brand, price, available, description, consumption, acceleration, vote, puissance } = req.body;
  if (!name || !brand || !price || available === undefined) {
    return res.status(400).json({ error: 'Nom, marque, prix et disponibilité sont requis' });
  }
  try {
    const carResult = await readPool.query('SELECT image_url FROM cars WHERE id = $1', [id]); // Lecture pour vérifier l’image existante
    if (carResult.rows.length === 0) return res.status(404).json({ error: 'Voiture non trouvée' });
    const oldImageUrl = carResult.rows[0].image_url;

    let imagePath = oldImageUrl;
    if (req.file) {
      const uploadResult = await cloudinary.uploader.upload(req.file.path, { folder: 'cars' });
      imagePath = uploadResult.secure_url;
      if (oldImageUrl && oldImageUrl.startsWith('https://res.cloudinary.com')) {
        const publicId = oldImageUrl.split('/').slice(-1)[0].split('.')[0];
        cloudinary.uploader.destroy(`cars/${publicId}`).catch(err => console.error('Erreur suppression ancienne image :', err));
      }
      fs.unlinkSync(req.file.path);
    }

    const { rows } = await writePool.query(
      'UPDATE cars SET name = $1, brand = $2, price = $3, available = $4, image_url = $5, description = $6, consumption = $7, acceleration = $8, vote = $9, puissance = $10 WHERE id = $11 RETURNING *',
      [name, brand, price, available === 'true' ? 1 : 0, imagePath, description || null, consumption || null, acceleration || null, vote || null, puissance || null, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Voiture non trouvée' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Erreur lors de la mise à jour de la voiture :', err);
    res.status(500).json({ error: 'Échec de la mise à jour de la voiture' });
  }
});

// DELETE /api/cars/:id
app.delete('/api/cars/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const carResult = await readPool.query('SELECT image_url FROM cars WHERE id = $1', [id]); // Lecture pour récupérer l’image
    if (carResult.rows.length === 0) return res.status(404).json({ error: 'Voiture non trouvée' });
    const imageUrl = carResult.rows[0].image_url;

    await writePool.query('DELETE FROM reservations WHERE car_id = $1', [id]);
    await writePool.query('DELETE FROM cars WHERE id = $1', [id]);

    if (imageUrl && imageUrl.startsWith('https://res.cloudinary.com')) {
      const publicId = imageUrl.split('/').slice(-1)[0].split('.')[0];
      cloudinary.uploader.destroy(`cars/${publicId}`).catch(err => console.error('Erreur suppression image :', err));
    }
    res.json({ message: 'Voiture supprimée avec succès', deletedCar: { id } });
  } catch (err) {
    console.error('Erreur lors de la suppression de la voiture :', err);
    res.status(500).json({ error: 'Échec de la suppression de la voiture' });
  }
});

// --- Customers Endpoints ---
app.get('/api/customers', async (req, res) => {
  try {
    const result = await readPool.query('SELECT * FROM customers');
    res.json(result.rows);
  } catch (err) {
    console.error('Erreur lors de la récupération des clients :', err);
    res.status(500).json({ error: 'Échec de la récupération des clients' });
  }
});

app.post('/api/customers', async (req, res) => {
  const { name, phone, email } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Nom et téléphone sont requis' });
  try {
    const { rows } = await writePool.query(
      'INSERT INTO customers (name, phone, email) VALUES ($1, $2, $3) RETURNING *',
      [name, phone, email || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Erreur lors de l’ajout du client :', err);
    res.status(500).json({ error: 'Échec de l’ajout du client' });
  }
});

app.put('/api/customers/:id', async (req, res) => {
  const id = req.params.id;
  const { name, phone, email } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Nom et téléphone sont requis' });
  try {
    const { rows } = await writePool.query(
      'UPDATE customers SET name = $1, phone = $2, email = $3 WHERE id = $4 RETURNING *',
      [name, phone, email || null, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Client non trouvé' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Erreur lors de la mise à jour du client :', err);
    res.status(500).json({ error: 'Échec de la mise à jour du client' });
  }
});

app.delete('/api/customers/:id', async (req, res) => {
  const id = req.params.id;
  try {
    await writePool.query('DELETE FROM reservations WHERE customer_id = $1', [id]);
    const { rowCount } = await writePool.query('DELETE FROM customers WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Client non trouvé' });
    res.json({ message: 'Client supprimé avec succès', deletedCustomer: { id } });
  } catch (err) {
    console.error('Erreur lors de la suppression du client :', err);
    res.status(500).json({ error: 'Échec de la suppression du client' });
  }
});

// --- Reservations Endpoints ---
app.get('/api/reservations', async (req, res) => {
  try {
    const result = await readPool.query(`
      SELECT r.*, c.name AS customer_name, c.phone AS customer_phone, ca.name AS car_name, ca.price AS car_price
      FROM reservations r
      JOIN customers c ON r.customer_id = c.id
      JOIN cars ca ON r.car_id = ca.id
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Erreur lors de la récupération des réservations :', err);
    res.status(500).json({ error: 'Échec de la récupération des réservations' });
  }
});

app.post('/api/reservations', async (req, res) => {
  const { customer_id, car_id, start_date, end_date, status } = req.body;
  if (!customer_id || !car_id || !start_date || !end_date) {
    return res.status(400).json({ error: 'ID client, ID voiture, date de début et date de fin sont requis' });
  }
  const client = await writePool.connect(); // Transaction sur writePool
  try {
    await client.query('BEGIN');
    const carResult = await client.query('SELECT price, available FROM cars WHERE id = $1', [car_id]);
    if (carResult.rows.length === 0) throw new Error('Voiture non trouvée');
    const car = carResult.rows[0];
    if (!car.available) throw new Error('La voiture n’est pas disponible');

    const days = Math.ceil((new Date(end_date) - new Date(start_date)) / (1000 * 60 * 60 * 24));
    const total = car.price * days;

    const reservationResult = await client.query(
      'INSERT INTO reservations (customer_id, car_id, start_date, end_date, total, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [customer_id, car_id, start_date, end_date, total, status || 'pending']
    );
    await client.query('UPDATE cars SET available = 0, reservations_count = reservations_count + 1 WHERE id = $1', [car_id]);
    await client.query(
      'UPDATE customers SET reservations_count = reservations_count + 1, total_spent = total_spent + $1 WHERE id = $2',
      [total, customer_id]
    );
    await client.query('COMMIT');
    res.status(201).json(reservationResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erreur lors de l’ajout de la réservation :', err);
    res.status(500).json({ error: err.message || 'Échec de l’ajout de la réservation' });
  } finally {
    client.release();
  }
});

app.put('/api/reservations/:id', async (req, res) => {
  const id = req.params.id;
  const { customer_id, car_id, start_date, end_date, status } = req.body;
  if (!customer_id || !car_id || !start_date || !end_date) {
    return res.status(400).json({ error: 'ID client, ID voiture, date de début et date de fin sont requis' });
  }
  try {
    const carResult = await readPool.query('SELECT price FROM cars WHERE id = $1', [car_id]); // Lecture du prix
    if (carResult.rows.length === 0) return res.status(404).json({ error: 'Voiture non trouvée' });
    const days = Math.ceil((new Date(end_date) - new Date(start_date)) / (1000 * 60 * 60 * 24));
    const total = carResult.rows[0].price * days;

    const { rows } = await writePool.query(
      'UPDATE reservations SET customer_id = $1, car_id = $2, start_date = $3, end_date = $4, total = $5, status = $6 WHERE id = $7 RETURNING *',
      [customer_id, car_id, start_date, end_date, total, status || 'pending', id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Réservation non trouvée' });

    if (status === 'completed' || status === 'canceled') {
      await writePool.query('UPDATE cars SET available = 1 WHERE id = $1', [car_id]);
    } else if (status === 'active' || status === 'pending') {
      await writePool.query('UPDATE cars SET available = 0 WHERE id = $1', [car_id]);
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Erreur lors de la mise à jour de la réservation :', err);
    res.status(500).json({ error: 'Échec de la mise à jour de la réservation' });
  }
});

app.delete('/api/reservations/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const reservationResult = await readPool.query('SELECT car_id, total, customer_id FROM reservations WHERE id = $1', [id]); // Lecture des données
    if (reservationResult.rows.length === 0) return res.status(404).json({ error: 'Réservation non trouvée' });
    const { car_id, total, customer_id } = reservationResult.rows[0];

    await writePool.query('DELETE FROM reservations WHERE id = $1', [id]);
    await writePool.query('UPDATE cars SET available = 1, reservations_count = reservations_count - 1 WHERE id = $1', [car_id]);
    await writePool.query(
      'UPDATE customers SET reservations_count = reservations_count - 1, total_spent = total_spent - $1 WHERE id = $2',
      [total, customer_id]
    );
    res.json({ message: 'Réservation supprimée avec succès', deletedReservation: { id } });
  } catch (err) {
    console.error('Erreur lors de la suppression de la réservation :', err);
    res.status(500).json({ error: 'Échec de la suppression de la réservation' });
  }
});

// --- Settings Endpoints ---
app.get('/api/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM settings WHERE id = 1');
    if (result.rows.length === 0) {
      return res.json({
        site_name: 'Luxury Drive',
        phone: '212000000',
        contact_email: 'admin@luxurydrive.com',
        facebook: 'facebook.com',
        instagram: 'instagram.com',
        adress: 'adress',
        gps: 'gps',
        maintenance_mode: 0,
      });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erreur lors de la récupération des paramètres :', err);
    res.status(500).json({ error: 'Échec de la récupération des paramètres' });
  }
});

app.put('/api/settings', async (req, res) => {
  const { site_name, phone, contact_email, facebook, instagram, adress, gps, maintenance_mode } = req.body;
  try {
    const result = await pool.query('SELECT * FROM settings WHERE id = 1');
    if (result.rows.length > 0) {
      const { rows } = await pool.query(
        'UPDATE settings SET site_name = $1, phone = $2, contact_email = $3, facebook = $4, instagram = $5, adress = $6, gps = $7, maintenance_mode = $8 WHERE id = 1 RETURNING *',
        [site_name, phone, contact_email, facebook, instagram, adress, gps, maintenance_mode ? 1 : 0]
      );
      res.json(rows[0]);
    } else {
      const { rows } = await pool.query(
        'INSERT INTO settings (id, site_name, phone, contact_email, facebook, instagram, adress, gps, maintenance_mode) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
        [site_name, phone, contact_email, facebook, instagram, adress, gps, maintenance_mode ? 1 : 0]
      );
      res.json(rows[0]);
    }
  } catch (err) {
    console.error('Erreur lors de la mise à jour des paramètres :', err);
    res.status(500).json({ error: 'Échec de la mise à jour des paramètres' });
  }
});

// --- Testimonials Endpoints ---
app.get('/api/testimonials', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM testimonials ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Erreur lors de la récupération des témoignages :', err);
    res.status(500).json({ error: 'Échec de la récupération des témoignages' });
  }
});

app.post('/api/testimonials', async (req, res) => {
  const { name, role, content, rating } = req.body;
  if (!name || !role || !content || !rating) {
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO testimonials (name, role, content, rating) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, role, content, rating]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Erreur lors de l’ajout du témoignage :', err);
    res.status(500).json({ error: 'Échec de l’ajout du témoignage' });
  }
});

app.put('/api/testimonials/:id', async (req, res) => {
  const id = req.params.id;
  const { name, role, content, rating } = req.body;
  if (!name || !role || !content || !rating) {
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  }
  try {
    const { rows } = await pool.query(
      'UPDATE testimonials SET name = $1, role = $2, content = $3, rating = $4 WHERE id = $5 RETURNING *',
      [name, role, content, rating, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Témoignage non trouvé' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Erreur lors de la mise à jour du témoignage :', err);
    res.status(500).json({ error: 'Échec de la mise à jour du témoignage' });
  }
});

app.delete('/api/testimonials/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const { rowCount } = await pool.query('DELETE FROM testimonials WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Témoignage non trouvé' });
    res.json({ message: 'Témoignage supprimé avec succès', deletedId: id });
  } catch (err) {
    console.error('Erreur lors de la suppression du témoignage :', err);
    res.status(500).json({ error: 'Échec de la suppression du témoignage' });
  }
});

// Démarrer le serveur
const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`Serveur démarré sur le port ${port} (Neon PostgreSQL)`);
});

// Fermeture propre
process.on('SIGINT', async () => {
  await writePool.end();
  await readPool.end();
  console.log('Connexions aux bases de données Neon fermées.');
  process.exit(0);
});