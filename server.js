const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

// Middleware setup
app.use(cors());
app.use(bodyParser.json());
// Serve uploads directory (optional, only if you still have local images to serve)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// SQLite database connection
const db = new sqlite3.Database('./luxury_drive.db', (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log('Connected to the SQLite database.');
    }
});

// Enable foreign key support
db.serialize(() => {
    db.run('PRAGMA foreign_keys = ON;');
});

// Create tables
const createTables = () => {
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS cars (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
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
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                email TEXT,
                reservations_count INTEGER DEFAULT 0,
                total_spent REAL DEFAULT 0
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS reservations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL,
                car_id INTEGER NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                total REAL NOT NULL,
                status TEXT NOT NULL,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
                FOREIGN KEY (car_id) REFERENCES cars(id) ON DELETE CASCADE
            )
        `);
        db.run(`
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
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS testimonials (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                rating INTEGER NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);
    });
};
createTables();

// Multer configuration for file uploads (temporary local storage before Cloudinary)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const tempFilename = `temp_${Date.now()}${path.extname(file.originalname)}`;
        cb(null, tempFilename);
    },
});
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|gif/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) return cb(null, true);
        cb(new Error('Only images are allowed (jpeg, jpg, png, gif)'));
    },
});

// Cloudinary configuration
const cloudinary = require('cloudinary').v2;
cloudinary.config({
    cloud_name: 'dluqdzeml',
    api_key: '982631744688698',
    api_secret: 'obQzDBDjB8qswwwSKJtYbL7f-S4'
});

// Root endpoint
app.get('/', (req, res) => {
    res.send('Luxury Drive API (SQLite) is running!');
});

// --- Cars Endpoints ---
app.get('/api/cars', (req, res) => {
    db.all('SELECT * FROM cars', [], (err, rows) => {
        if (err) {
            console.error('Error fetching cars:', err);
            res.status(500).json({ error: 'Failed to fetch cars' });
        } else {
            res.json(rows);
        }
    });
});

// POST /api/cars - Add a new car with Cloudinary
app.post('/api/cars', upload.single('image'), (req, res) => {
    const { name, brand, price, available, description, consumption, acceleration, puissance } = req.body;
    if (!name || !brand || !price || available === undefined || !req.file || !description || !consumption || !acceleration || !puissance) {
        return res.status(400).json({ error: 'All fields are required, including an image' });
    }
    cloudinary.uploader.upload(req.file.path, { folder: 'cars' }, (error, result) => {
        if (error) {
            console.error('Error uploading to Cloudinary:', error);
            return res.status(500).json({ error: 'Failed to upload image' });
        }
        const imagePath = result.secure_url; // Cloudinary URL
        db.run(
            'INSERT INTO cars (name, brand, price, available, image_url, description, acceleration, consumption, puissance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [name, brand, price, available === 'true' ? 1 : 0, imagePath, description, acceleration, consumption, puissance],
            function (err) {
                if (err) {
                    console.error('Error adding car:', err);
                    res.status(500).json({ error: 'Failed to add car' });
                } else {
                    db.get('SELECT * FROM cars WHERE id = ?', [this.lastID], (err, row) => {
                        if (err) {
                            res.status(500).json({ error: 'Failed to retrieve inserted car' });
                        } else {
                            res.status(201).json(row);
                        }
                    });
                }
            }
        );
        fs.unlinkSync(req.file.path); // Clean up temporary file
    });
});

// PUT /api/cars/:id - Update a car with Cloudinary
app.put('/api/cars/:id', upload.single('image'), (req, res) => {
    const id = req.params.id;
    const { name, brand, price, available, description, consumption, acceleration, vote, puissance } = req.body;

    if (!name || !brand || !price || available === undefined) {
        return res.status(400).json({ error: 'Name, brand, price, and available are required' });
    }

    db.get('SELECT image_url FROM cars WHERE id = ?', [id], (err, row) => {
        if (err) {
            console.error('Error fetching car:', err);
            return res.status(500).json({ error: 'Failed to update car' });
        }
        if (!row) return res.status(404).json({ error: 'Car not found' });

        const updateCarData = (imagePath) => {
            db.run(
                'UPDATE cars SET name = ?, brand = ?, price = ?, available = ?, image_url = ?, description = ?, consumption = ?, acceleration = ?, vote = ?, puissance = ? WHERE id = ?',
                [name, brand, price, available === 'true' ? 1 : 0, imagePath, description || null, consumption || null, acceleration || null, vote || null, puissance || null, id],
                function (err) {
                    if (err) {
                        console.error('Error updating car:', err);
                        res.status(500).json({ error: 'Failed to update car' });
                    } else if (this.changes === 0) {
                        res.status(404).json({ error: 'Car not found' });
                    } else {
                        db.get('SELECT * FROM cars WHERE id = ?', [id], (err, updatedRow) => {
                            if (err) {
                                res.status(500).json({ error: 'Failed to retrieve updated car' });
                            } else {
                                res.json(updatedRow);
                            }
                        });
                    }
                }
            );
        };

        if (req.file) {
            // Upload new image to Cloudinary
            cloudinary.uploader.upload(req.file.path, { folder: 'cars' }, (error, result) => {
                if (error) {
                    console.error('Error uploading to Cloudinary:', error);
                    return res.status(500).json({ error: 'Failed to upload image' });
                }
                const newImagePath = result.secure_url;

                // Optionally delete the old image from Cloudinary if it exists and is a Cloudinary URL
                if (row.image_url && row.image_url.startsWith('https://res.cloudinary.com')) {
                    const publicId = row.image_url.split('/').slice(-1)[0].split('.')[0]; // Extract public ID
                    cloudinary.uploader.destroy(`cars/${publicId}`, (deleteErr) => {
                        if (deleteErr) console.error('Error deleting old image from Cloudinary:', deleteErr);
                    });
                }

                updateCarData(newImagePath);
                fs.unlinkSync(req.file.path); // Clean up temporary file
            });
        } else {
            // No new image uploaded, keep the existing image_url
            updateCarData(row.image_url);
        }
    });
});

app.delete('/api/cars/:id', (req, res) => {
    const id = req.params.id;
    db.get('SELECT image_url FROM cars WHERE id = ?', [id], (err, row) => {
        if (err) {
            console.error('Error fetching car:', err);
            return res.status(500).json({ error: 'Failed to delete car' });
        }
        if (!row) return res.status(404).json({ error: 'Car not found' });

        // Delete from reservations first due to foreign key constraint
        db.run('DELETE FROM reservations WHERE car_id = ?', [id], (err) => {
            if (err) {
                console.error('Error deleting reservations:', err);
                return res.status(500).json({ error: 'Failed to delete related reservations' });
            }
            db.run('DELETE FROM cars WHERE id = ?', [id], function (err) {
                if (err) {
                    console.error('Error deleting car:', err);
                    res.status(500).json({ error: 'Failed to delete car' });
                } else {
                    // Delete image from Cloudinary if it exists
                    if (row.image_url && row.image_url.startsWith('https://res.cloudinary.com')) {
                        const publicId = row.image_url.split('/').slice(-1)[0].split('.')[0];
                        cloudinary.uploader.destroy(`cars/${publicId}`, (deleteErr) => {
                            if (deleteErr) console.error('Error deleting image from Cloudinary:', deleteErr);
                        });
                    }
                    res.json({ message: 'Car deleted successfully', deletedCar: { id } });
                }
            });
        });
    });
});

// --- Customers Endpoints ---
app.get('/api/customers', (req, res) => {
    db.all('SELECT * FROM customers', [], (err, rows) => {
        if (err) {
            console.error('Error fetching customers:', err);
            res.status(500).json({ error: 'Failed to fetch customers' });
        } else {
            res.json(rows);
        }
    });
});

app.post('/api/customers', (req, res) => {
    const { name, phone, email } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });
    db.run(
        'INSERT INTO customers (name, phone, email) VALUES (?, ?, ?)',
        [name, phone, email || null],
        function (err) {
            if (err) {
                console.error('Error adding customer:', err);
                res.status(500).json({ error: 'Failed to add customer' });
            } else {
                db.get('SELECT * FROM customers WHERE id = ?', [this.lastID], (err, row) => {
                    if (err) {
                        res.status(500).json({ error: 'Failed to retrieve inserted customer' });
                    } else {
                        res.status(201).json(row);
                    }
                });
            }
        }
    );
});

app.put('/api/customers/:id', (req, res) => {
    const id = req.params.id;
    const { name, phone, email } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });
    db.run(
        'UPDATE customers SET name = ?, phone = ?, email = ? WHERE id = ?',
        [name, phone, email || null, id],
        function (err) {
            if (err) {
                console.error('Error updating customer:', err);
                res.status(500).json({ error: 'Failed to update customer' });
            } else if (this.changes === 0) {
                res.status(404).json({ error: 'Customer not found' });
            } else {
                db.get('SELECT * FROM customers WHERE id = ?', [id], (err, row) => {
                    if (err) {
                        res.status(500).json({ error: 'Failed to retrieve updated customer' });
                    } else {
                        res.json(row);
                    }
                });
            }
        }
    );
});

app.delete('/api/customers/:id', (req, res) => {
    const id = req.params.id;
    db.run('DELETE FROM reservations WHERE customer_id = ?', [id], (err) => {
        if (err) {
            console.error('Error deleting reservations:', err);
            return res.status(500).json({ error: 'Failed to delete related reservations' });
        }
        db.run('DELETE FROM customers WHERE id = ?', [id], function (err) {
            if (err) {
                console.error('Error deleting customer:', err);
                res.status(500).json({ error: 'Failed to delete customer' });
            } else if (this.changes === 0) {
                res.status(404).json({ error: 'Customer not found' });
            } else {
                res.json({ message: 'Customer deleted successfully', deletedCustomer: { id } });
            }
        });
    });
});

// --- Reservations Endpoints ---
app.get('/api/reservations', (req, res) => {
    db.all(`
        SELECT r.*, c.name AS customer_name, c.phone AS customer_phone, ca.name AS car_name, ca.price AS car_price
        FROM reservations r
        JOIN customers c ON r.customer_id = c.id
        JOIN cars ca ON r.car_id = ca.id
    `, [], (err, rows) => {
        if (err) {
            console.error('Error fetching reservations:', err);
            res.status(500).json({ error: 'Failed to fetch reservations' });
        } else {
            res.json(rows);
        }
    });
});

app.post('/api/reservations', (req, res) => {
    const { customer_id, car_id, start_date, end_date, status } = req.body;
    if (!customer_id || !car_id || !start_date || !end_date) {
        return res.status(400).json({ error: 'Customer ID, Car ID, start date, and end date are required' });
    }
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.get('SELECT price, available FROM cars WHERE id = ?', [car_id], (err, car) => {
            if (err) {
                db.run('ROLLBACK');
                console.error('Error fetching car:', err);
                return res.status(500).json({ error: 'Failed to add reservation' });
            }
            if (!car) {
                db.run('ROLLBACK');
                return res.status(404).json({ error: 'Car not found' });
            }
            if (!car.available) {
                db.run('ROLLBACK');
                return res.status(400).json({ error: 'Car is not available' });
            }
            const days = Math.ceil((new Date(end_date) - new Date(start_date)) / (1000 * 60 * 60 * 24));
            const total = car.price * days;
            db.run(
                'INSERT INTO reservations (customer_id, car_id, start_date, end_date, total, status) VALUES (?, ?, ?, ?, ?, ?)',
                [customer_id, car_id, start_date, end_date, total, status || 'pending'],
                function (err) {
                    if (err) {
                        db.run('ROLLBACK');
                        console.error('Error inserting reservation:', err);
                        res.status(500).json({ error: 'Failed to add reservation' });
                    } else {
                        const reservationId = this.lastID;
                        db.run('UPDATE cars SET available = 0, reservations_count = reservations_count + 1 WHERE id = ?', [car_id], (err) => {
                            if (err) {
                                db.run('ROLLBACK');
                                console.error('Error updating car:', err);
                                res.status(500).json({ error: 'Failed to add reservation' });
                            } else {
                                db.run(
                                    'UPDATE customers SET reservations_count = reservations_count + 1, total_spent = total_spent + ? WHERE id = ?',
                                    [total, customer_id],
                                    (err) => {
                                        if (err) {
                                            db.run('ROLLBACK');
                                            console.error('Error updating customer:', err);
                                            res.status(500).json({ error: 'Failed to add reservation' });
                                        } else {
                                            db.run('COMMIT');
                                            db.get('SELECT * FROM reservations WHERE id = ?', [reservationId], (err, row) => {
                                                if (err) {
                                                    res.status(500).json({ error: 'Failed to retrieve inserted reservation' });
                                                } else {
                                                    res.status(201).json(row);
                                                }
                                            });
                                        }
                                    }
                                );
                            }
                        });
                    }
                }
            );
        });
    });
});

app.put('/api/reservations/:id', (req, res) => {
    const id = req.params.id;
    const { customer_id, car_id, start_date, end_date, status } = req.body;
    if (!customer_id || !car_id || !start_date || !end_date) {
        return res.status(400).json({ error: 'Customer ID, Car ID, start date, and end date are required' });
    }
    db.get('SELECT price FROM cars WHERE id = ?', [car_id], (err, car) => {
        if (err) {
            console.error('Error fetching car:', err);
            return res.status(500).json({ error: 'Failed to update reservation' });
        }
        if (!car) return res.status(404).json({ error: 'Car not found' });
        const days = Math.ceil((new Date(end_date) - new Date(start_date)) / (1000 * 60 * 60 * 24));
        const total = car.price * days;
        db.run(
            'UPDATE reservations SET customer_id = ?, car_id = ?, start_date = ?, end_date = ?, total = ?, status = ? WHERE id = ?',
            [customer_id, car_id, start_date, end_date, total, status || 'pending', id],
            function (err) {
                if (err) {
                    console.error('Error updating reservation:', err);
                    res.status(500).json({ error: 'Failed to update reservation' });
                } else if (this.changes === 0) {
                    res.status(404).json({ error: 'Reservation not found' });
                } else {
                    if (status === 'completed' || status === 'canceled') {
                        db.run('UPDATE cars SET available = 1 WHERE id = ?', [car_id], (err) => {
                            if (err) console.error('Error updating car availability:', err);
                        });
                    } else if (status === 'active' || status === 'pending') {
                        db.run('UPDATE cars SET available = 0 WHERE id = ?', [car_id], (err) => {
                            if (err) console.error('Error updating car availability:', err);
                        });
                    }
                    db.get('SELECT * FROM reservations WHERE id = ?', [id], (err, row) => {
                        if (err) {
                            res.status(500).json({ error: 'Failed to retrieve updated reservation' });
                        } else {
                            res.json(row);
                        }
                    });
                }
            }
        );
    });
});

app.delete('/api/reservations/:id', (req, res) => {
    const id = req.params.id;
    db.get('SELECT car_id, total, customer_id FROM reservations WHERE id = ?', [id], (err, reservation) => {
        if (err) {
            console.error('Error fetching reservation:', err);
            return res.status(500).json({ error: 'Failed to delete reservation' });
        }
        if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
        db.run('DELETE FROM reservations WHERE id = ?', [id], function (err) {
            if (err) {
                console.error('Error deleting reservation:', err);
                res.status(500).json({ error: 'Failed to delete reservation' });
            } else {
                db.run('UPDATE cars SET available = 1, reservations_count = reservations_count - 1 WHERE id = ?', [reservation.car_id], (err) => {
                    if (err) console.error('Error updating car:', err);
                    db.run(
                        'UPDATE customers SET reservations_count = reservations_count - 1, total_spent = total_spent - ? WHERE id = ?',
                        [reservation.total, reservation.customer_id],
                        (err) => {
                            if (err) console.error('Error updating customer:', err);
                            res.json({ message: 'Reservation deleted successfully', deletedReservation: { id } });
                        }
                    );
                });
            }
        });
    });
});

// --- Settings Endpoints ---
app.get('/api/settings', (req, res) => {
    db.get('SELECT * FROM settings WHERE id = 1', (err, row) => {
        if (err) {
            console.error('Error fetching settings:', err);
            res.status(500).json({ error: 'Failed to fetch settings' });
        } else {
            res.json(row || { site_name: 'Luxury Drive', phone: '212000000', contact_email: 'admin@luxurydrive.com', facebook: 'facebook.com', instagram: 'instagram.com', adress: 'adress', gps: 'gps', maintenance_mode: 0 });
        }
    });
});

app.put('/api/settings', (req, res) => {
    const { site_name, phone, contact_email, facebook, instagram, adress, gps, maintenance_mode } = req.body;
    db.get('SELECT * FROM settings WHERE id = 1', (err, row) => {
        if (err) {
            console.error('Error checking settings:', err);
            return res.status(500).json({ error: 'Failed to update settings' });
        }
        if (row) {
            db.run(
                `UPDATE settings SET site_name = ?, phone = ?, contact_email = ?, facebook = ?, instagram = ?, adress = ?, gps = ?, maintenance_mode = ? WHERE id = 1`,
                [site_name, phone, contact_email, facebook, instagram, adress, gps, maintenance_mode ? 1 : 0],
                function (err) {
                    if (err) {
                        console.error('Error updating settings:', err);
                        res.status(500).json({ error: 'Failed to update settings' });
                    } else {
                        db.get('SELECT * FROM settings WHERE id = 1', (err, updatedRow) => {
                            if (err) {
                                res.status(500).json({ error: 'Failed to retrieve updated settings' });
                            } else {
                                res.json(updatedRow);
                            }
                        });
                    }
                }
            );
        } else {
            db.run(
                `INSERT INTO settings (id, site_name, phone, contact_email, facebook, instagram, adress, gps, maintenance_mode) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [site_name, phone, contact_email, facebook, instagram, adress, gps, maintenance_mode ? 1 : 0],
                function (err) {
                    if (err) {
                        console.error('Error inserting settings:', err);
                        res.status(500).json({ error: 'Failed to insert settings' });
                    } else {
                        db.get('SELECT * FROM settings WHERE id = 1', (err, insertedRow) => {
                            if (err) {
                                res.status(500).json({ error: 'Failed to retrieve inserted settings' });
                            } else {
                                res.json(insertedRow);
                            }
                        });
                    }
                }
            );
        }
    });
});

// --- Testimonials Endpoints ---
app.get('/api/testimonials', (req, res) => {
    db.all('SELECT * FROM testimonials ORDER BY created_at DESC', [], (err, rows) => {
        if (err) {
            console.error('Error fetching testimonials:', err);
            res.status(500).json({ error: 'Failed to fetch testimonials' });
        } else {
            res.json(rows);
        }
    });
});

app.post('/api/testimonials', (req, res) => {
    const { name, role, content, rating } = req.body;
    if (!name || !role || !content || !rating) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    db.run(
        'INSERT INTO testimonials (name, role, content, rating) VALUES (?, ?, ?, ?)',
        [name, role, content, rating],
        function (err) {
            if (err) {
                console.error('Error adding testimonial:', err);
                res.status(500).json({ error: 'Failed to add testimonial' });
            } else {
                db.get('SELECT * FROM testimonials WHERE id = ?', [this.lastID], (err, row) => {
                    if (err) {
                        res.status(500).json({ error: 'Failed to retrieve inserted testimonial' });
                    } else {
                        res.status(201).json(row);
                    }
                });
            }
        }
    );
});

app.put('/api/testimonials/:id', (req, res) => {
    const id = req.params.id;
    const { name, role, content, rating } = req.body;
    if (!name || !role || !content || !rating) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    db.run(
        'UPDATE testimonials SET name = ?, role = ?, content = ?, rating = ? WHERE id = ?',
        [name, role, content, rating, id],
        function (err) {
            if (err) {
                console.error('Error updating testimonial:', err);
                res.status(500).json({ error: 'Failed to update testimonial' });
            } else if (this.changes === 0) {
                res.status(404).json({ error: 'Testimonial not found' });
            } else {
                db.get('SELECT * FROM testimonials WHERE id = ?', [id], (err, row) => {
                    if (err) {
                        res.status(500).json({ error: 'Failed to retrieve updated testimonial' });
                    } else {
                        res.json(row);
                    }
                });
            }
        }
    );
});

app.delete('/api/testimonials/:id', (req, res) => {
    const id = req.params.id;
    db.run('DELETE FROM testimonials WHERE id = ?', [id], function (err) {
        if (err) {
            console.error('Error deleting testimonial:', err);
            res.status(500).json({ error: 'Failed to delete testimonial' });
        } else if (this.changes === 0) {
            res.status(404).json({ error: 'Testimonial not found' });
        } else {
            res.json({ message: 'Testimonial deleted successfully', deletedId: id });
        }
    });
});

// Start the server
const port = process.env.PORT || 5000;
app.listen(port, () => {
    console.log(`Server listening on port ${port} (SQLite)`);
});

// Close database connection on process termination
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err);
        }
        console.log('Database connection closed.');
        process.exit(0);
    });
});