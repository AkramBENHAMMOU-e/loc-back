const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs'); // Synchronous fs module
const fsPromises = require('fs').promises; // Promise-based fs module
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());
app.use('/uploads', express.static('uploads'));


// Fonction utilitaire pour réinitialiser les IDs dans une table
async function resetAutoIncrement(tableName, pool) {
    try {
      // 1. Fetch all remaining rows
      const [rows] = await pool.query(`SELECT * FROM ${tableName} ORDER BY id`);
  
      // 2. If no rows remain, just reset AUTO_INCREMENT and return
      if (rows.length === 0) {
        await pool.query(`ALTER TABLE ${tableName} AUTO_INCREMENT = 1`);
        return true;
      }
  
      // 3. Get column names excluding 'id'
      const [columns] = await pool.query(`SHOW COLUMNS FROM ${tableName}`);
      const columnNames = columns
        .map(col => col.Field)
        .filter(name => name !== 'id')
        .join(', ');
  
      // 4. Create a temporary table to hold data
      await pool.query(`CREATE TEMPORARY TABLE temp_${tableName} LIKE ${tableName}`);
  
      // 5. Copy data to temporary table
      await pool.query(`INSERT INTO temp_${tableName} SELECT * FROM ${tableName} ORDER BY id`);
  
      // 6. Disable foreign key checks temporarily (if applicable)
      await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  
      // 7. Truncate the original table to reset IDs
      await pool.query(`TRUNCATE TABLE ${tableName}`);
  
      // 8. Reset AUTO_INCREMENT
      await pool.query(`ALTER TABLE ${tableName} AUTO_INCREMENT = 1`);
  
      // 9. Reinsert data without IDs (let MySQL assign new IDs)
      await pool.query(`
        INSERT INTO ${tableName} (${columnNames})
        SELECT ${columnNames} FROM temp_${tableName} ORDER BY id
      `);
  
      // 10. Re-enable foreign key checks
      await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  
      // 11. Drop temporary table
      await pool.query(`DROP TEMPORARY TABLE IF EXISTS temp_${tableName}`);
  
      return true;
    } catch (err) {
      console.error(`Error resetting IDs for ${tableName}:`, err);
      return false;
    }
  }

// MySQL connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT),
});

// Multer configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = process.env.UPLOAD_DIR || './uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); // Use synchronous fs
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const tempFilename = `temp_${Date.now()}${path.extname(file.originalname)}`;
        cb(null, tempFilename);
    },
});
const upload = multer({
    storage,
    limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|gif/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) return cb(null, true);
        cb(new Error('Only images are allowed (jpeg, jpg, png, gif)'));
    },
});

// Root endpoint
app.get('/', (req, res) => {
    res.send('Luxury Drive API (MySQL) is running!');
});

// --- Cars Endpoints (unchanged from your code, included for completeness) ---
app.get('/api/cars', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM cars');
        res.json(rows);
    } catch (err) {
        console.error('Error fetching cars:', err);
        res.status(500).json({ error: 'Failed to fetch cars' });
    }
});

app.post('/api/cars', upload.single('image'), async (req, res) => {
    try {
        const { name, brand, price, available, description, consumption, acceleration, puissance } = req.body;
        if (!name || !brand || !price || available === undefined || !req.file || !description || !consumption || !acceleration || !puissance) {
            return res.status(400).json({ error: 'All fields are required, including an image' });
        }
        const customName = `${brand}_${name}`.replace(/\s+/g, '_').toLowerCase();
        const fileExt = path.extname(req.file.originalname);
        const finalFileName = `${customName}${fileExt}`;
        const tempFilePath = req.file.path;
        const newFilePath = path.join(process.env.UPLOAD_DIR || 'uploads', finalFileName);
        await fsPromises.rename(tempFilePath, newFilePath); // Use fsPromises.rename
        const imagePath = `${process.env.UPLOAD_DIR || 'uploads'}/${finalFileName}`;
        const [result] = await pool.query(
            'INSERT INTO cars (name, brand, price, available, image_url, description, acceleration, consumption, puissance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [name, brand, price, available === 'true' ? 1 : 0, imagePath, description, acceleration, consumption, puissance]
        );
        const [insertedRows] = await pool.query('SELECT * FROM cars WHERE id = ?', [result.insertId]);
        res.status(201).json(insertedRows[0]);
    } catch (err) {
        console.error('Error adding car:', err);
        res.status(500).json({ error: 'Failed to add car' });
    }
});

app.put('/api/cars/:id', upload.single('image'), async (req, res) => {
    try {
        const id = req.params.id;
        const { name, brand, price, available, description, consumption, acceleration, vote, puissance } = req.body;

        // Only require essential fields
        if (!name || !brand || !price || available === undefined) {
            return res.status(400).json({ error: 'Name, brand, price, and available are required' });
        }

        let imagePath;
        if (req.file) {
            const customName = `${brand}_${name}`.replace(/\s+/g, '_').toLowerCase();
            const fileExt = path.extname(req.file.originalname);
            const finalFileName = `${customName}${fileExt}`;
            const tempFilePath = req.file.path;
            const newFilePath = path.join(process.env.UPLOAD_DIR || 'uploads', finalFileName);
            await fsPromises.rename(tempFilePath, newFilePath);
            imagePath = `${process.env.UPLOAD_DIR || 'uploads'}/${finalFileName}`;
            
            const [oldImage] = await pool.query('SELECT image_url FROM cars WHERE id = ?', [id]);
            if (oldImage.length > 0 && oldImage[0].image_url && fs.existsSync(oldImage[0].image_url)) {
                await fsPromises.unlink(oldImage[0].image_url);
            }
        } else {
            const [oldImage] = await pool.query('SELECT image_url FROM cars WHERE id = ?', [id]);
            imagePath = oldImage.length > 0 ? oldImage[0].image_url : null;
        }

        const [result] = await pool.query(
            'UPDATE cars SET name = ?, brand = ?, price = ?, available = ?, image_url = ?, description = ?, consumption = ?, acceleration = ?, vote = ?, puissance = ? WHERE id = ?',
            [
                name,
                brand,
                price,
                available === 'true' ? 1 : 0,
                imagePath,
                description || null,
                consumption || null,
                acceleration || null,
                vote || null,
                puissance || null,
                id
            ]
        );

        if (result.affectedRows === 0) return res.status(404).json({ error: 'Car not found' });
        
        const [updatedRows] = await pool.query('SELECT * FROM cars WHERE id = ?', [id]);
        res.json(updatedRows[0]);
    } catch (err) {
        console.error('Error updating car:', err);
        res.status(500).json({ error: 'Failed to update car: ' + err.message });
    }
});

app.delete('/api/cars/:id', async (req, res) => {
    try {
      const id = req.params.id;
  
      // Check if car exists
      const [carData] = await pool.query('SELECT image_url FROM cars WHERE id = ?', [id]);
      if (carData.length === 0) return res.status(404).json({ error: 'Car not found' });
  
      // Delete related reservations first
      await pool.query('DELETE FROM reservations WHERE car_id = ?', [id]);
  
      // Delete the car
      const [result] = await pool.query('DELETE FROM cars WHERE id = ?', [id]);
      if (carData[0].image_url && fs.existsSync(carData[0].image_url)) {
        await fsPromises.unlink(carData[0].image_url);
      }
  
      // Reset IDs for cars
      await resetAutoIncrement('cars', pool);
  
      res.json({ message: 'Car deleted successfully and IDs reset', deletedCar: { id } });
    } catch (err) {
      console.error('Error deleting car:', err);
      res.status(500).json({ error: 'Failed to delete car' });
    }
  });

// --- Customers Endpoints ---
app.get('/api/customers', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM customers');
        res.json(rows);
    } catch (err) {
        console.error('Error fetching customers:', err);
        res.status(500).json({ error: 'Failed to fetch customers' });
    }
});

app.post('/api/customers', async (req, res) => {
    try {
        const { name, phone, email } = req.body;
        if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });
        const [result] = await pool.query(
            'INSERT INTO customers (name, phone, email) VALUES (?, ?, ?)',
            [name, phone, email || null]
        );
        const [insertedRows] = await pool.query('SELECT * FROM customers WHERE id = ?', [result.insertId]);
        res.status(201).json(insertedRows[0]);
    } catch (err) {
        console.error('Error adding customer:', err);
        res.status(500).json({ error: 'Failed to add customer' });
    }
});

app.put('/api/customers/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const { name, phone, email } = req.body;
        if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });
        const [result] = await pool.query(
            'UPDATE customers SET name = ?, phone = ?, email = ? WHERE id = ?',
            [name, phone, email || null, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Customer not found' });
        const [updatedRows] = await pool.query('SELECT * FROM customers WHERE id = ?', [id]);
        res.json(updatedRows[0]);
    } catch (err) {
        console.error('Error updating customer:', err);
        res.status(500).json({ error: 'Failed to update customer' });
    }
});

app.delete('/api/customers/:id', async (req, res) => {
    try {
      const id = req.params.id;
  
      // Delete related reservations
      await pool.query('DELETE FROM reservations WHERE customer_id = ?', [id]);
  
      // Delete the customer
      const [result] = await pool.query('DELETE FROM customers WHERE id = ?', [id]);
      if (result.affectedRows === 0) return res.status(404).json({ error: 'Customer not found' });
  
      // Reset IDs for customers
      await resetAutoIncrement('customers', pool);
  
      res.json({ message: 'Customer deleted successfully and IDs reset', deletedCustomer: { id } });
    } catch (err) {
      console.error('Error deleting customer:', err);
      res.status(500).json({ error: 'Failed to delete customer' });
    }
  });
// --- Reservations Endpoints ---
app.get('/api/reservations', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT r.*, c.name AS customer_name, c.phone AS customer_phone, ca.name AS car_name, ca.price AS car_price
            FROM reservations r
            JOIN customers c ON r.customer_id = c.id
            JOIN cars ca ON r.car_id = ca.id
        `);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching reservations:', err);
        res.status(500).json({ error: 'Failed to fetch reservations' });
    }
});

app.post('/api/reservations', async (req, res) => {
    try {
        const { customer_id, car_id, start_date, end_date, status } = req.body;
        if (!customer_id || !car_id || !start_date || !end_date) {
            return res.status(400).json({ error: 'Customer ID, Car ID, start date, and end date are required' });
        }

        // Calculate total cost
        const [car] = await pool.query('SELECT price FROM cars WHERE id = ?', [car_id]);
        if (car.length === 0) return res.status(404).json({ error: 'Car not found' });
        const days = Math.ceil((new Date(end_date) - new Date(start_date)) / (1000 * 60 * 60 * 24));
        const total = car[0].price * days;

        // Check car availability
        const [carAvailability] = await pool.query('SELECT available FROM cars WHERE id = ?', [car_id]);
        if (!carAvailability[0].available) return res.status(400).json({ error: 'Car is not available' });

        // Insert reservation
        const [result] = await pool.query(
            'INSERT INTO reservations (customer_id, car_id, start_date, end_date, total, status) VALUES (?, ?, ?, ?, ?, ?)',
            [customer_id, car_id, start_date, end_date, total, status || 'pending']
        );

        // Update car's availability and reservations count
        await pool.query('UPDATE cars SET available = 0, reservations_count = reservations_count + 1 WHERE id = ?', [car_id]);
        // Update customer's reservations count and total spent
        await pool.query(
            'UPDATE customers SET reservations_count = reservations_count + 1, total_spent = total_spent + ? WHERE id = ?',
            [total, customer_id]
        );

        const [insertedRows] = await pool.query('SELECT * FROM reservations WHERE id = ?', [result.insertId]);
        res.status(201).json(insertedRows[0]);
    } catch (err) {
        console.error('Error adding reservation:', err);
        res.status(500).json({ error: 'Failed to add reservation' });
    }
});

app.put('/api/reservations/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const { customer_id, car_id, start_date, end_date, status } = req.body;
        if (!customer_id || !car_id || !start_date || !end_date) {
            return res.status(400).json({ error: 'Customer ID, Car ID, start date, and end date are required' });
        }

        // Recalculate total if dates change
        const [car] = await pool.query('SELECT price FROM cars WHERE id = ?', [car_id]);
        if (car.length === 0) return res.status(404).json({ error: 'Car not found' });
        const days = Math.ceil((new Date(end_date) - new Date(start_date)) / (1000 * 60 * 60 * 24));
        const total = car[0].price * days;

        const [result] = await pool.query(
            'UPDATE reservations SET customer_id = ?, car_id = ?, start_date = ?, end_date = ?, total = ?, status = ? WHERE id = ?',
            [customer_id, car_id, start_date, end_date, total, status || 'pending', id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Reservation not found' });

        // Update car availability based on status
        if (status === 'completed' || status === 'canceled') {
            await pool.query('UPDATE cars SET available = 1 WHERE id = ?', [car_id]);
        } else if (status === 'active' || status === 'pending') {
            await pool.query('UPDATE cars SET available = 0 WHERE id = ?', [car_id]);
        }

        const [updatedRows] = await pool.query('SELECT * FROM reservations WHERE id = ?', [id]);
        res.json(updatedRows[0]);
    } catch (err) {
        console.error('Error updating reservation:', err);
        res.status(500).json({ error: 'Failed to update reservation' });
    }
});

app.delete('/api/reservations/:id', async (req, res) => {
    try {
      const id = req.params.id;
  
      // Fetch reservation details to update related entities
      const [reservation] = await pool.query('SELECT car_id, total, customer_id FROM reservations WHERE id = ?', [id]);
      if (reservation.length === 0) return res.status(404).json({ error: 'Reservation not found' });
  
      // Delete the reservation
      const [result] = await pool.query('DELETE FROM reservations WHERE id = ?', [id]);
  
      // Update car availability and reservation count
      await pool.query('UPDATE cars SET available = 1, reservations_count = reservations_count - 1 WHERE id = ?', [reservation[0].car_id]);
      await pool.query(
        'UPDATE customers SET reservations_count = reservations_count - 1, total_spent = total_spent - ? WHERE id = ?',
        [reservation[0].total, reservation[0].customer_id]
      );
  
      // Reset IDs for reservations
      await resetAutoIncrement('reservations', pool);
  
      res.json({ message: 'Reservation deleted successfully and IDs reset', deletedReservation: { id } });
    } catch (err) {
      console.error('Error deleting reservation:', err);
      res.status(500).json({ error: 'Failed to delete reservation' });
    }
  });

// Fetch settings
app.get('/api/settings', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM settings WHERE id = 1');
        res.json(rows[0] || { 
            site_name: 'Luxury Drive',
            phone: '212000000', 
            contact_email: 'admin@luxurydrive.com',
            facebook: 'facebook.com',
            instagram: 'instagram.com', 
            adress: 'adress',
            gps: 'gps', 
            maintenance_mode: 0 
        });
    } catch (err) {
        console.error('Error fetching settings:', err);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// Update settings
app.put('/api/settings', async (req, res) => {
    try {
        const { site_name, phone, contact_email, facebook, instagram, adress, gps, maintenance_mode } = req.body;
        const [result] = await pool.query(
            `INSERT INTO settings (id, site_name, phone, contact_email, facebook, instagram, adress, gps, maintenance_mode)
             VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
             site_name = VALUES(site_name),
             phone = VALUES(phone),
             contact_email = VALUES(contact_email),
             facebook = VALUES(facebook),
             instagram = VALUES(instagram),
             adress = VALUES(adress),
             gps = VALUES(gps),
             maintenance_mode = VALUES(maintenance_mode)`,
            [site_name, phone, contact_email, facebook, instagram, adress, gps, maintenance_mode ? 1 : 0]
        );
        const [updatedRows] = await pool.query('SELECT * FROM settings WHERE id = 1');
        res.json(updatedRows[0]);
    } catch (err) {
        console.error('Error updating settings:', err);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

//Testimonials
app.get('/api/testimonials', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM testimonials ORDER BY created_at DESC');
      res.json(rows); // Ensure this returns an array
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch testimonials' });
    }
  });

app.post('/api/testimonials', async (req, res) => {
    try {
        const { name, role, content, rating } = req.body;
        if (!name || !role || !content || !rating) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        const [result] = await pool.query(
            'INSERT INTO testimonials (name, role, content, rating) VALUES (?, ?, ?, ?)',
            [name, role, content, rating]
        );
        const [insertedRows] = await pool.query('SELECT * FROM testimonials WHERE id = ?', [result.insertId]);
        res.status(201).json(insertedRows[0]);
    } catch (err) {
        console.error('Error adding testimonial:', err);
        res.status(500).json({ error: 'Failed to add testimonial' });
    }
});

app.put('/api/testimonials/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const { name, role, content, rating } = req.body;
        if (!name || !role || !content || !rating) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        const [result] = await pool.query(
            'UPDATE testimonials SET name = ?, role = ?, content = ?, rating = ? WHERE id = ?',
            [name, role, content, rating, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Testimonial not found' });
        const [updatedRows] = await pool.query('SELECT * FROM testimonials WHERE id = ?', [id]);
        res.json(updatedRows[0]);
    } catch (err) {
        console.error('Error updating testimonial:', err);
        res.status(500).json({ error: 'Failed to update testimonial' });
    }
});

app.delete('/api/testimonials/:id', async (req, res) => {
    try {
      const id = req.params.id;
  
      // Delete the testimonial
      const [result] = await pool.query('DELETE FROM testimonials WHERE id = ?', [id]);
      if (result.affectedRows === 0) return res.status(404).json({ error: 'Testimonial not found' });
  
      // Reset IDs for testimonials
      await resetAutoIncrement('testimonials', pool);
  
      res.json({ message: 'Testimonial deleted successfully and IDs reset', deletedId: id });
    } catch (err) {
      console.error('Error deleting testimonial:', err);
      res.status(500).json({ error: 'Failed to delete testimonial' });
    }
  });

app.listen(port, () => {
    console.log(`Server listening on port ${port} (MySQL)`);
});