// services/filterService.js
const fs = require('fs');
const path = require('path');

const FILTERS_FILE = path.join(__dirname, '../data/savedFilters.json');

// Ensure data folder and file exist
const initializeStorage = () => {
  const dataDir = path.join(__dirname, '../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(FILTERS_FILE)) {
    fs.writeFileSync(FILTERS_FILE, JSON.stringify([], null, 2));
  }
};

initializeStorage();

// Load all filters
const loadFilters = () => {
  try {
    const data = fs.readFileSync(FILTERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error loading filters:', err);
    return [];
  }
};

// Save filters back to file
const saveFilters = (filters) => {
  try {
    fs.writeFileSync(FILTERS_FILE, JSON.stringify(filters, null, 2));
  } catch (err) {
    console.error('Error saving filters:', err);
  }
};

class FilterService {
  getAllFilters() {
    return loadFilters();
  }

  saveFilter(name, config, overwrite = false) {
    let filters = loadFilters();

    const existingIndex = filters.findIndex(f => 
      f.name.toLowerCase() === name.toLowerCase()
    );

    if (existingIndex !== -1) {
      if (!overwrite) {
        throw new Error(`Filter with name "${name}" already exists.`);
      }
      // Overwrite
      filters[existingIndex] = {
        id: filters[existingIndex].id,
        name: name,
        config: config,
        createdAt: filters[existingIndex].createdAt,
        updatedAt: new Date().toISOString()
      };
    } else {
      // Create new
      filters.push({
        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
        name: name,
        config: config,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    saveFilters(filters);
    return { 
      success: true, 
      name: name, 
      overwritten: existingIndex !== -1 
    };
  }
}

module.exports = new FilterService();
