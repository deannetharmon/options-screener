const fs = require('fs');
const path = require('path');

const FILTERS_FILE = path.join(__dirname, '../data/savedFilters.json');

// Load filters
const loadFilters = () => {
  try {
    if (fs.existsSync(FILTERS_FILE)) {
      return JSON.parse(fs.readFileSync(FILTERS_FILE, 'utf8'));
    }
    return [];
  } catch (err) {
    console.error('Error loading filters:', err);
    return [];
  }
};

// Save filters
const saveFiltersToFile = (filters) => {
  fs.writeFileSync(FILTERS_FILE, JSON.stringify(filters, null, 2));
};

class FilterService {
  getAllFilters() {
    return loadFilters();
  }

  getFilterByName(name) {
    return loadFilters().find(f => f.name.toLowerCase() === name.toLowerCase());
  }

  // Main save logic
  async saveFilter(name, filterConfig, overwrite = false) {
    let filters = loadFilters();
    
    const existingIndex = filters.findIndex(f => 
      f.name.toLowerCase() === name.toLowerCase()
    );

    if (existingIndex !== -1) {
      if (!overwrite) {
        throw new Error(`Filter "${name}" already exists. Use overwrite: true or choose a different name.`);
      }
      // Overwrite
      filters[existingIndex] = {
        ...filters[existingIndex],
        name,
        config: filterConfig,
        updatedAt: new Date().toISOString()
      };
    } else {
      // Create new
      filters.push({
        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
        name,
        config: filterConfig,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    saveFiltersToFile(filters);
    return { success: true, name, overwritten: existingIndex !== -1 };
  }

  deleteFilter(name) {
    let filters = loadFilters();
    filters = filters.filter(f => f.name.toLowerCase() !== name.toLowerCase());
    saveFiltersToFile(filters);
    return { success: true };
  }
}

module.exports = new FilterService();
